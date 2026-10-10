use manager_protocol::{ProcessIdentityRequest, SidecarEnvelope, SidecarReply, SidecarRequest};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn test_sidecar_stdio_protocol() {
    let bin_path = env!("CARGO_BIN_EXE_dcm-manager");
    let mut child = Command::new(bin_path)
        .arg("sidecar")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("failed to spawn dcm-manager sidecar");

    let mut stdin = child.stdin.take().expect("failed to take stdin");
    let stdout = child.stdout.take().expect("failed to take stdout");
    let mut reader = BufReader::new(stdout);

    // 1. Send valid request
    let current_pid = std::process::id();
    let req1 = SidecarEnvelope {
        id: 1,
        request: SidecarRequest::ProcessIdentity(ProcessIdentityRequest { pid: current_pid }),
    };
    let req1_str = serde_json::to_string(&req1).unwrap();
    writeln!(stdin, "{}", req1_str).unwrap();
    stdin.flush().unwrap();

    let mut line1 = String::new();
    reader.read_line(&mut line1).unwrap();
    let reply1: SidecarReply = serde_json::from_str(&line1).expect("deserialize reply 1");
    assert_eq!(reply1.id, 1);
    assert!(reply1.result.is_some());
    assert!(reply1.error.is_none());

    // 2. Send malformed request
    writeln!(stdin, "{{\"id\": 42, \"method\": \"unknown/method\"}}").unwrap();
    stdin.flush().unwrap();

    let mut line2 = String::new();
    reader.read_line(&mut line2).unwrap();
    let reply2: SidecarReply = serde_json::from_str(&line2).expect("deserialize reply 2");
    assert_eq!(reply2.id, 42);
    assert!(reply2.error.is_some());
    assert_eq!(reply2.error.as_ref().unwrap().code, "MALFORMED_REQUEST");

    // 3. Verify sidecar is still alive and processes subsequent requests
    let req3 = SidecarEnvelope {
        id: 43,
        request: SidecarRequest::ProcessIdentity(ProcessIdentityRequest { pid: current_pid }),
    };
    let req3_str = serde_json::to_string(&req3).unwrap();
    writeln!(stdin, "{}", req3_str).unwrap();
    stdin.flush().unwrap();

    let mut line3 = String::new();
    reader.read_line(&mut line3).unwrap();
    let reply3: SidecarReply = serde_json::from_str(&line3).expect("deserialize reply 3");
    assert_eq!(reply3.id, 43);
    assert!(reply3.result.is_some());

    // 4. Graceful EOF handling
    drop(stdin);
    let exit_status = child.wait().expect("child exit status");
    assert!(exit_status.success(), "Sidecar should exit cleanly on EOF");
}
