use manager_protocol::UpstreamFailureKind;
use manager_worker::{WorkerClient, WorkerLaunchConfig};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

fn create_mock_config(script: &str, temp_subdir: &str) -> WorkerLaunchConfig {
    let runtime_dir = std::env::temp_dir()
        .join("dcm-test-worker-client")
        .join(temp_subdir);
    let _ = std::fs::remove_dir_all(&runtime_dir);
    std::fs::create_dir_all(runtime_dir.join("logs")).unwrap();

    let mut env = HashMap::new();
    for (k, v) in std::env::vars() {
        env.insert(k, v);
    }

    WorkerLaunchConfig {
        worker_id: "test-worker".into(),
        command: PathBuf::from("node"),
        args: vec!["-e".into(), script.into()],
        env,
        runtime_dir,
    }
}

#[tokio::test]
async fn test_client_handshake_list_tools_and_call_tool() {
    let script = r#"
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, terminal: false });
        rl.on('line', (line) => {
            const req = JSON.parse(line);
            if (req.method === 'initialize') {
                console.log(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test' } }
                }));
            } else if (req.method === 'tools/list') {
                console.log(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { tools: [{ name: 'echo', description: 'Echo tool' }] }
                }));
            } else if (req.method === 'tools/call') {
                console.log(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { content: [{ type: 'text', text: req.params.arguments.text }], isError: false }
                }));
            }
        });
    "#;

    let config = create_mock_config(script, "happy-path");
    let logs_dir = config.runtime_dir.join("logs");

    let client = WorkerClient::spawn(config, None)
        .await
        .expect("spawn client");
    assert!(client.is_alive());
    assert!(client.pid() > 0);

    // 1. Handshake
    client
        .handshake(Duration::from_secs(5))
        .await
        .expect("handshake");

    // 2. List tools
    let tools_res = client
        .list_tools(None, Duration::from_secs(5))
        .await
        .expect("list_tools");
    assert_eq!(tools_res.tools.len(), 1);
    assert_eq!(tools_res.tools[0]["name"], "echo");

    // 3. Call tool
    let call_res = client
        .call_tool(
            "echo",
            json!({ "text": "hello-from-rust" }),
            None,
            Duration::from_secs(5),
        )
        .await
        .expect("call_tool");
    assert_eq!(call_res.is_error, Some(false));
    assert_eq!(call_res.content[0]["text"], "hello-from-rust");

    // 4. Stop
    client.stop().await.expect("stop client");

    // Verify stdout log was written
    let stdout_log = std::fs::read_to_string(logs_dir.join("stdout.log")).unwrap_or_default();
    assert!(stdout_log.contains("protocolVersion"));
    assert!(stdout_log.contains("echo"));
}

#[tokio::test]
async fn test_client_error_classifications() {
    // Mock server returns an RPC error on tools/call, then exits on next request
    let script = r#"
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, terminal: false });
        rl.on('line', (line) => {
            const req = JSON.parse(line);
            if (req.method === 'tools/call') {
                console.log(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { code: -32603, message: 'Internal tool failure' }
                }));
            } else if (req.method === 'hang') {
                // Do not respond (simulate hang/timeout)
            } else if (req.method === 'crash') {
                process.exit(42);
            }
        });
    "#;

    let config = create_mock_config(script, "error-classifications");
    let client = WorkerClient::spawn(config, None)
        .await
        .expect("spawn client");

    // 1. UpstreamError classification
    let err = client
        .call_tool("fail", json!({}), None, Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), UpstreamFailureKind::UpstreamError);
    assert!(err.to_string().contains("Internal tool failure"));

    // 2. AckUnknown on timeout
    let timeout_err = client
        .send_request("hang", json!({}), Duration::from_millis(100))
        .await
        .unwrap_err();
    assert_eq!(timeout_err.kind(), UpstreamFailureKind::AckUnknown);

    // 3. AckUnknown when worker crashes mid-flight
    let crash_err = client
        .send_request("crash", json!({}), Duration::from_secs(2))
        .await
        .unwrap_err();
    assert_eq!(crash_err.kind(), UpstreamFailureKind::AckUnknown);

    // Wait for process exit to settle
    let exit_code = client.wait_for_exit().await;
    assert_eq!(exit_code, Some(42));
    assert!(!client.is_alive());

    // 4. PreDispatch when sending to dead worker
    let dead_err = client
        .send_request("anything", json!({}), Duration::from_secs(1))
        .await
        .unwrap_err();
    assert_eq!(dead_err.kind(), UpstreamFailureKind::PreDispatch);
}
