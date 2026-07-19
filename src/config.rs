use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    pub caddyfile_path: String,
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("OPS_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5000);

        let data_dir = std::env::var("OPS_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("data"));

        let caddyfile_path = std::env::var("CADDYFILE_PATH")
            .unwrap_or_else(|_| "/etc/caddy/Caddyfile".into());

        Self {
            port,
            data_dir,
            caddyfile_path,
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("ops.db")
    }
}
