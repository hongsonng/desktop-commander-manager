use std::path::Path;
use tower_http::services::ServeDir;

pub fn create_static_service(dir: &Path) -> Option<ServeDir> {
    if dir.exists() && dir.is_dir() {
        Some(ServeDir::new(dir).append_index_html_on_directories(true))
    } else {
        None
    }
}
