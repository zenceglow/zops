use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    pub caddyfile_path: String,
    /// 服务的部署根目录。每个服务一个子目录。
    pub deploy_dir: PathBuf,
    /// 界面默认语言。安装脚本写进来的 `OPS_DEFAULT_LANG`；空串 = 跟随浏览器。
    pub default_lang: String,
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

        let deploy_dir = std::env::var("OPS_DEPLOY_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/opt/docker-apps"));

        // 只认 en / zh，别的一律当没设 —— 一个拼错的取值不该让界面变成空白。
        let default_lang = match std::env::var("OPS_DEFAULT_LANG")
            .unwrap_or_default()
            .trim()
            .to_lowercase()
            .as_str()
        {
            "en" => "en".to_string(),
            "zh" => "zh".to_string(),
            _ => String::new(),
        };

        Self {
            port,
            data_dir,
            caddyfile_path,
            deploy_dir,
            default_lang,
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("ops.db")
    }
}
