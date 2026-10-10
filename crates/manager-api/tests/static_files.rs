use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use manager_api::routes::create_router;
use manager_api::state::ApiState;
use manager_db::ManagerDb;
use std::fs;
use std::sync::Arc;
use tempfile::tempdir;
use tokio::sync::Mutex;
use tower::ServiceExt;

#[tokio::test]
async fn test_serves_index_html_and_assets() {
    let temp = tempdir().unwrap();
    let dist = temp.path().join("dist");
    let assets = dist.join("assets");
    fs::create_dir_all(&assets).unwrap();

    let index_content = "<!doctype html><title>CONTRACT_DASHBOARD</title>";
    let asset_content = "console.log('dashboard-asset');";

    fs::write(dist.join("index.html"), index_content).unwrap();
    fs::write(assets.join("main.js"), asset_content).unwrap();

    let db = Arc::new(Mutex::new(ManagerDb::open_in_memory().unwrap()));
    let mut state = ApiState::new(db);
    state.dashboard_dir = Some(dist);

    let router = create_router(state);

    // 1. Root / serves index.html
    let res = router
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(String::from_utf8_lossy(&bytes), index_content);

    // 2. /index.html serves index.html
    let res = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/index.html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(String::from_utf8_lossy(&bytes), index_content);

    // 3. /assets/main.js serves asset
    let res = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/assets/main.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(String::from_utf8_lossy(&bytes), asset_content);
}

#[tokio::test]
async fn test_missing_dashboard_dir_leaves_api_working_and_returns_404_for_static() {
    let db = Arc::new(Mutex::new(ManagerDb::open_in_memory().unwrap()));
    let mut state = ApiState::new(db);
    state.dashboard_dir = Some(std::path::PathBuf::from("C:\\nonexistent\\dashboard\\dist"));

    let router = create_router(state);

    // API route works
    let res = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Static root returns 404
    let res = router
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_directory_traversal_attempts_cannot_escape_root() {
    let temp = tempdir().unwrap();
    let secret_file = temp.path().join("secret.txt");
    fs::write(&secret_file, "SUPER_SECRET_TOKEN").unwrap();

    let dist = temp.path().join("dist");
    fs::create_dir_all(&dist).unwrap();
    fs::write(dist.join("index.html"), "Normal index").unwrap();

    let db = Arc::new(Mutex::new(ManagerDb::open_in_memory().unwrap()));
    let mut state = ApiState::new(db);
    state.dashboard_dir = Some(dist);

    let router = create_router(state);

    // Try path traversal
    for traversal_uri in &[
        "/..%2Fsecret.txt",
        "/../secret.txt",
        "/assets/../../secret.txt",
        "/%2e%2e%2fsecret.txt",
    ] {
        let res = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(*traversal_uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // Tower ServeDir either returns NOT_FOUND or BAD_REQUEST for traversal
        assert!(
            res.status() == StatusCode::NOT_FOUND
                || res.status() == StatusCode::BAD_REQUEST
                || res.status() == StatusCode::FORBIDDEN,
            "Traversal uri {} returned status {}",
            traversal_uri,
            res.status()
        );

        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body_str = String::from_utf8_lossy(&bytes);
        assert!(!body_str.contains("SUPER_SECRET_TOKEN"));
    }
}
