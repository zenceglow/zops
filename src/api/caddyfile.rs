use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

type ApiError = (StatusCode, &'static str);

// ---------- data types ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteEntry {
    pub addr: String,
    pub directives: Vec<Directive>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Directive {
    pub key: String,
    pub args: Vec<String>,
    pub sub: Vec<Directive>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Caddyfile {
    pub sites: Vec<SiteEntry>,
    pub preamble: String,
}

#[derive(Serialize)]
pub struct CaddyfileResponse {
    pub raw: String,
    pub parsed: Caddyfile,
}

#[derive(Deserialize)]
pub struct UpdateCaddyfileRequest {
    pub raw: String,
}

// ---------- parser ----------

pub fn parse_caddyfile(raw: &str) -> Caddyfile {
    let mut sites = Vec::new();
    let mut preamble_lines: Vec<String> = Vec::new();
    let mut in_preamble = true;

    let mut pos = 0;
    let lines: Vec<&str> = raw.lines().collect();

    while pos < lines.len() {
        let line = lines[pos].trim();
        pos += 1;

        if line.is_empty() || line.starts_with('#') {
            if in_preamble {
                preamble_lines.push(lines[pos - 1].to_string());
            }
            continue;
        }

        if line.contains('{') && !line.starts_with('}') {
            in_preamble = false;
            let addr = line.trim_end_matches('{').trim().to_string();
            let (directives, consumed) = parse_block(&lines, pos);
            pos += consumed;
            sites.push(SiteEntry { addr, directives });
        } else if in_preamble {
            preamble_lines.push(lines[pos - 1].to_string());
        }
    }

    Caddyfile {
        sites,
        preamble: preamble_lines.join("\n"),
    }
}

fn parse_block(lines: &[&str], start: usize) -> (Vec<Directive>, usize) {
    let mut directives = Vec::new();
    let mut i = start;

    while i < lines.len() {
        let raw = lines[i];
        let trimmed = raw.trim();

        if trimmed == "}" {
            i += 1;
            break;
        }

        if trimmed.is_empty() || trimmed.starts_with('#') {
            i += 1;
            continue;
        }

        // sub-block: dir { ... }
        if trimmed.ends_with('{') {
            let key_args: Vec<&str> = trimmed.trim_end_matches('{').trim().split_whitespace().collect();
            let (key, args) = key_args.split_first().unwrap_or((&"", &[]));
            let (sub, consumed) = parse_block(&lines[i + 1..], 0);
            directives.push(Directive {
                key: key.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
                sub,
            });
            i += consumed + 1;
            continue;
        }

        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if let Some((key, args)) = parts.split_first() {
            directives.push(Directive {
                key: key.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
                sub: Vec::new(),
            });
        }

        i += 1;
    }

    (directives, i - start)
}

// ---------- recompose ----------

pub fn recompose_caddyfile(cf: &Caddyfile) -> String {
    let mut out = String::new();

    if !cf.preamble.is_empty() {
        out.push_str(&cf.preamble);
        if !cf.preamble.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }

    for site in &cf.sites {
        out.push_str(&format!("{} {{\n", site.addr));
        for d in &site.directives {
            write_directive(&mut out, d, 1);
        }
        out.push_str("}\n\n");
    }

    out
}

fn write_directive(out: &mut String, d: &Directive, indent: usize) {
    let pad = "    ".repeat(indent);
    if d.sub.is_empty() {
        let args = d.args.join(" ");
        if args.is_empty() {
            out.push_str(&format!("{}{}\n", pad, d.key));
        } else {
            out.push_str(&format!("{}{} {}\n", pad, d.key, args));
        }
    } else {
        let args = d.args.join(" ");
        if args.is_empty() {
            out.push_str(&format!("{}{} {{\n", pad, d.key));
        } else {
            out.push_str(&format!("{}{} {} {{\n", pad, d.key, args));
        }
        for sub in &d.sub {
            write_directive(out, sub, indent + 1);
        }
        out.push_str(&format!("{}}}\n", pad));
    }
}

// ---------- handlers ----------

async fn get_caddyfile(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CaddyfileResponse>, ApiError> {
    let raw = tokio::fs::read_to_string(&state.caddyfile_path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "读取配置文件失败"))?;

    let parsed = parse_caddyfile(&raw);

    Ok(Json(CaddyfileResponse { raw, parsed }))
}

async fn update_caddyfile(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdateCaddyfileRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    // extract before any await to avoid holding MutexGuard across await
    let caddy_bin = state.caddy_bin.lock().unwrap().clone();
    let caddyfile_path = state.caddyfile_path.clone();

    let validated = if let Some(bin) = &caddy_bin {
        let formatted = tokio::task::spawn_blocking({
            let raw = body.raw.clone();
            let bin = bin.clone();
            move || -> Result<String, String> {
                let mut child = std::process::Command::new(&bin)
                    .arg("fmt")
                    .arg("--parser")
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("caddy fmt 启动失败: {e}"))?;

                {
                    use std::io::Write;
                    let mut stdin = child.stdin.take().unwrap();
                    stdin.write_all(raw.as_bytes()).map_err(|e| format!("写入 stdin 失败: {e}"))?;
                }

                let output = child
                    .wait_with_output()
                    .map_err(|e| format!("caddy fmt 执行失败: {e}"))?;

                if !output.status.success() {
                    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(if err.is_empty() { "Caddyfile 语法错误".into() } else { err });
                }

                Ok(String::from_utf8_lossy(&output.stdout).to_string())
            }
        })
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "内部错误"}))))?
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e}))))?;

        formatted
    } else {
        body.raw
    };

    tokio::fs::write(&caddyfile_path, &validated)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "写入配置文件失败"}))))?;

    Ok(Json(serde_json::json!({"ok": true, "formatted": validated})))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", axum::routing::get(get_caddyfile))
        .route("/", axum::routing::put(update_caddyfile))
}
