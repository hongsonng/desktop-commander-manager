use dcm_manager::management_server::{ManagementServerError, ManagementServerManager};
use manager_api::state::ApiState;
use manager_db::ManagerDb;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

async fn http_get(url: &str) -> Result<(u16, String), std::io::Error> {
    let stripped = url.strip_prefix("http://").unwrap();
    let mut parts = stripped.splitn(2, '/');
    let host_port = parts.next().unwrap();
    let path = format!("/{}", parts.next().unwrap_or(""));

    let mut stream = TcpStream::connect(host_port).await?;
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host_port
    );
    stream.write_all(req.as_bytes()).await?;
    let mut resp = String::new();
    stream.read_to_string(&mut resp).await?;
    let status_line = resp.lines().next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok((status, resp))
}

#[tokio::test]
async fn test_management_server_lifecycle() {
    let db = ManagerDb::open_in_memory().unwrap();
    let state = ApiState::new(Arc::new(Mutex::new(db)));
    let server = ManagementServerManager::new();

    // 1. Start on ephemeral port 0
    let url = server.start("127.0.0.1", 0, state).await.unwrap();
    assert!(url.starts_with("http://127.0.0.1:"));
    assert_eq!(server.get_url().await, Some(url.clone()));

    // 2. Query /api/health
    let (status, resp) = http_get(&format!("{}/api/health", url)).await.unwrap();
    assert_eq!(status, 200);
    assert!(resp.contains(r#""status":"ok""#));

    // 3. Query /api/connection
    let (status, resp) = http_get(&format!("{}/api/connection", url)).await.unwrap();
    assert_eq!(status, 200);
    assert!(resp.contains(r#""mode":"direct-local""#));

    // 4. Stop server
    assert!(server.stop().await);
    assert_eq!(server.get_url().await, None);

    // 5. Subsequent request must fail (listener closed)
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let err = http_get(&format!("{}/api/health", url)).await;
    assert!(err.is_err());

    // 6. Stopping again returns false
    assert!(!server.stop().await);
}

#[tokio::test]
async fn test_management_server_double_start_error() {
    let db = ManagerDb::open_in_memory().unwrap();
    let state = ApiState::new(Arc::new(Mutex::new(db)));
    let server = ManagementServerManager::new();

    let url = server.start("127.0.0.1", 0, state.clone()).await.unwrap();
    assert!(url.starts_with("http://127.0.0.1:"));

    // Attempt second start while already running
    let err = server.start("127.0.0.1", 0, state).await;
    match err {
        Err(ManagementServerError::AlreadyRunning) => (),
        other => panic!("Expected AlreadyRunning error, got {:?}", other),
    }

    assert!(server.stop().await);
}

#[tokio::test]
async fn test_management_server_bind_failure_occupied_port() {
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = occupied.local_addr().unwrap().port();

    let db = ManagerDb::open_in_memory().unwrap();
    let state = ApiState::new(Arc::new(Mutex::new(db)));
    let server = ManagementServerManager::new();

    let err = server.start("127.0.0.1", port, state).await;
    match err {
        Err(ManagementServerError::Bind(host, p, _)) => {
            assert_eq!(host, "127.0.0.1");
            assert_eq!(p, port);
        }
        other => panic!("Expected Bind error, got {:?}", other),
    }

    assert_eq!(server.get_url().await, None);
    assert!(!server.stop().await);
}
