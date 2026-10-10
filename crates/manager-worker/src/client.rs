use crate::config::WorkerLaunchConfig;
use crate::error::WorkerClientError;
use manager_platform::{KillProcessTreeRequest, ProcessPlatform};
use manager_protocol::{WorkerCallToolResult, WorkerListToolsResult};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, watch};

type PendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, WorkerClientError>>>>>;

pub struct WorkerClient {
    worker_id: String,
    pid: u32,
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    pending: PendingRequests,
    next_id: AtomicU64,
    exit_rx: watch::Receiver<Option<i32>>,
    kill_tx: tokio::sync::mpsc::Sender<()>,
    platform: Option<Arc<dyn ProcessPlatform>>,
}

impl WorkerClient {
    pub async fn spawn(
        config: WorkerLaunchConfig,
        platform: Option<Arc<dyn ProcessPlatform>>,
    ) -> Result<Self, WorkerClientError> {
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args);
        cmd.envs(&config.env);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW
            cmd.creation_flags(0x08000000);
        }

        let mut child = cmd.spawn().map_err(WorkerClientError::Io)?;
        let pid = child.id().ok_or_else(|| {
            WorkerClientError::pre_dispatch("Spawned process did not return a PID")
        })?;

        let child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| WorkerClientError::pre_dispatch("Failed to capture worker stdin"))?;
        let child_stdout = child
            .stdout
            .take()
            .ok_or_else(|| WorkerClientError::pre_dispatch("Failed to capture worker stdout"))?;
        let child_stderr = child
            .stderr
            .take()
            .ok_or_else(|| WorkerClientError::pre_dispatch("Failed to capture worker stderr"))?;

        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (exit_tx, exit_rx) = watch::channel(None);

        let logs_dir = config.runtime_dir.join("logs");
        let stdout_log = logs_dir.join("stdout.log");
        let stderr_log = logs_dir.join("stderr.log");

        // Stderr reader loop
        tokio::spawn(async move {
            let mut reader = BufReader::new(child_stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                append_log_line(&stderr_log, &line);
            }
        });

        // Stdout reader & RPC dispatch loop
        let pending_clone = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut reader = BufReader::new(child_stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                append_log_line(&stdout_log, &line);
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                    if let Some(id_val) = val.get("id").and_then(|i| i.as_u64()) {
                        let sender = {
                            let mut map = pending_clone.lock().unwrap();
                            map.remove(&id_val)
                        };
                        if let Some(tx) = sender {
                            if let Some(err) = val.get("error") {
                                let msg = err
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("JSON-RPC error");
                                let _ = tx.send(Err(WorkerClientError::upstream_error(msg)));
                            } else if let Some(res) = val.get("result") {
                                let _ = tx.send(Ok(res.clone()));
                            } else {
                                let _ = tx.send(Err(WorkerClientError::post_dispatch(
                                    "JSON-RPC response had neither result nor error",
                                )));
                            }
                        }
                    }
                }
            }

            // If stdout closes, fail any remaining pending requests
            let mut map = pending_clone.lock().unwrap();
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(WorkerClientError::ack_unknown(
                    "Worker stdout closed while awaiting response",
                )));
            }
        });

        let (kill_tx, mut kill_rx) = tokio::sync::mpsc::channel::<()>(1);
        tokio::spawn(async move {
            tokio::select! {
                res = child.wait() => {
                    let code = match res {
                        Ok(status) => status.code(),
                        Err(_) => Some(-1),
                    };
                    let _ = exit_tx.send(code);
                }
                _ = kill_rx.recv() => {
                    let _ = child.start_kill();
                    let res = child.wait().await;
                    let code = match res {
                        Ok(status) => status.code(),
                        Err(_) => Some(-1),
                    };
                    let _ = exit_tx.send(code);
                }
            }
        });

        Ok(Self {
            worker_id: config.worker_id,
            pid,
            stdin: Arc::new(tokio::sync::Mutex::new(child_stdin)),
            pending,
            next_id: AtomicU64::new(1),
            exit_rx,
            kill_tx,
            platform,
        })
    }

    pub fn worker_id(&self) -> &str {
        &self.worker_id
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn is_alive(&self) -> bool {
        self.exit_rx.borrow().is_none()
    }

    pub fn exit_code(&self) -> Option<i32> {
        *self.exit_rx.borrow()
    }

    pub async fn wait_for_exit(&mut self) -> Option<i32> {
        if let Some(code) = *self.exit_rx.borrow() {
            return Some(code);
        }
        let _ = self.exit_rx.changed().await;
        *self.exit_rx.borrow()
    }

    pub async fn send_request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, WorkerClientError> {
        if !self.is_alive() {
            return Err(WorkerClientError::pre_dispatch(
                "Worker process is not running",
            ));
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        let mut payload = match serde_json::to_string(&body) {
            Ok(p) => p,
            Err(e) => {
                self.pending.lock().unwrap().remove(&id);
                return Err(WorkerClientError::pre_dispatch(format!(
                    "Failed to serialize request: {e}"
                )));
            }
        };
        payload.push('\n');

        let write_result = {
            let mut stdin_guard = self.stdin.lock().await;
            match stdin_guard.write_all(payload.as_bytes()).await {
                Ok(_) => stdin_guard.flush().await,
                Err(e) => Err(e),
            }
        };

        if let Err(e) = write_result {
            self.pending.lock().unwrap().remove(&id);
            return Err(WorkerClientError::pre_dispatch(format!(
                "Failed to write to worker stdin: {e}"
            )));
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.pending.lock().unwrap().remove(&id);
                Err(WorkerClientError::ack_unknown(
                    "Worker connection dropped while waiting for response",
                ))
            }
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(WorkerClientError::ack_unknown(format!(
                    "Request {id} timed out after {timeout:?}"
                )))
            }
        }
    }

    pub async fn send_notification(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(), WorkerClientError> {
        if !self.is_alive() {
            return Err(WorkerClientError::pre_dispatch(
                "Worker process is not running",
            ));
        }

        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });

        let mut payload = match serde_json::to_string(&body) {
            Ok(p) => p,
            Err(e) => {
                return Err(WorkerClientError::pre_dispatch(format!(
                    "Failed to serialize notification: {e}"
                )));
            }
        };
        payload.push('\n');

        let mut stdin_guard = self.stdin.lock().await;
        stdin_guard
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| {
                WorkerClientError::pre_dispatch(format!("Failed to write notification: {e}"))
            })?;
        stdin_guard.flush().await.map_err(|e| {
            WorkerClientError::pre_dispatch(format!("Failed to flush notification: {e}"))
        })?;

        Ok(())
    }

    pub async fn handshake(&self, timeout: Duration) -> Result<(), WorkerClientError> {
        let init_params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "desktop-commander-manager",
                "version": "0.1.0"
            }
        });

        let _resp = self
            .send_request("initialize", init_params, timeout)
            .await?;
        self.send_notification("notifications/initialized", serde_json::json!({}))
            .await?;
        Ok(())
    }

    pub async fn list_tools(
        &self,
        meta: Option<Value>,
        timeout: Duration,
    ) -> Result<WorkerListToolsResult, WorkerClientError> {
        let params = match meta {
            Some(m) => serde_json::json!({ "_meta": m }),
            None => serde_json::json!({}),
        };

        let resp = self.send_request("tools/list", params, timeout).await?;
        let tools = resp
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        Ok(WorkerListToolsResult { tools })
    }

    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Value,
        meta: Option<Value>,
        timeout: Duration,
    ) -> Result<WorkerCallToolResult, WorkerClientError> {
        let mut params = serde_json::json!({
            "name": name,
            "arguments": arguments,
        });

        if let Some(m) = meta {
            params["_meta"] = m;
        }

        let resp = self.send_request("tools/call", params, timeout).await?;
        let content = resp
            .get("content")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
        let is_error = resp.get("isError").and_then(|e| e.as_bool());

        Ok(WorkerCallToolResult { content, is_error })
    }

    pub async fn stop(&self) -> Result<(), WorkerClientError> {
        if !self.is_alive() {
            return Ok(());
        }

        // 1. Terminate process tree
        if let Some(ref platform) = self.platform {
            let req = KillProcessTreeRequest {
                pid: self.pid,
                expected_creation_time_100ns: None,
            };
            let _ = platform.kill_tree(&req);
        }

        // 2. Signal child process kill
        let _ = self.kill_tx.send(()).await;

        // 3. Wait up to 2 seconds for clean exit
        let mut rx = self.exit_rx.clone();
        let _ = tokio::time::timeout(Duration::from_secs(2), async move {
            while rx.borrow().is_none() {
                if rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;

        Ok(())
    }
}

fn append_log_line(path: &PathBuf, line: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", line);
    }
}
