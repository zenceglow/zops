pub fn which_caddy() -> Option<String> {
    let candidates = ["/usr/bin/caddy", "/usr/local/bin/caddy", "/opt/caddy/caddy"];
    candidates
        .iter()
        .find(|p| std::path::Path::new(p).is_file())
        .map(|s| s.to_string())
        .or_else(|| {
            std::process::Command::new("which")
                .arg("caddy")
                .output()
                .ok()
                .and_then(|o| {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                })
        })
}

pub fn version(bin: &str) -> String {
    std::process::Command::new(bin)
        .arg("version")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8(o.stdout)
                .ok()
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default()
}

pub fn pid() -> Option<i32> {
    std::process::Command::new("pgrep")
        .arg("-x")
        .arg("caddy")
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            s.lines().next().and_then(|l| l.parse::<i32>().ok())
        })
}
