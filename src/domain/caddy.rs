use serde::{Deserialize, Serialize};

/// 面板管理的站点块用这两行标记包起来。
///
/// 为什么要标记：Caddyfile 是一份**纯文本**，没有结构可言。没有标记的话，"删掉
/// 某个站点"只能靠正则去猜哪一段是它 —— 猜错一次就是改坏别人的配置。有了标记，
/// 每一段的边界是明确的，增删都只动自己那一段。
///
/// 手写的、没有标记的块照样能用，只是面板不会去动它们（`managed: false`）。
pub const MARK_BEGIN: &str = "# ZOPS:BEGIN";
pub const MARK_END: &str = "# ZOPS:END";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteEntry {
    pub addr: String,
    pub directives: Vec<Directive>,
    /// 这一段在原文里的行范围（0 起，含首尾）。删除时按它切。
    #[serde(default)]
    pub start_line: usize,
    #[serde(default)]
    pub end_line: usize,
    /// 被 `# ZOPS:BEGIN/END` 包起来的块。面板只管这些。
    #[serde(default)]
    pub managed: bool,
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
pub struct CaddyfileData {
    pub raw: String,
    pub parsed: Caddyfile,
}

pub fn parse_caddyfile(raw: &str) -> Caddyfile {
    let mut sites = Vec::new();
    let mut preamble_lines: Vec<String> = Vec::new();
    let mut in_preamble = true;
    // 上一个 BEGIN 标记（行号 + 地址）：紧跟着的那个块就是它标记的。
    let mut pending_marker: Option<(usize, String)> = None;

    let mut pos = 0;
    let lines: Vec<&str> = raw.lines().collect();

    while pos < lines.len() {
        let line = lines[pos].trim();
        let line_no = pos;
        pos += 1;

        if let Some(rest) = line.strip_prefix(MARK_BEGIN) {
            pending_marker = Some((line_no, rest.trim().to_string()));
            continue;
        }
        if line.starts_with(MARK_END) {
            continue;
        }

        if line.is_empty() || line.starts_with('#') {
            if in_preamble {
                preamble_lines.push(lines[line_no].to_string());
            }
            continue;
        }

        // 顶部的全局选项块：整份 Caddyfile 只有一个，写法就是光秃秃一个 `{`。
        // 之前这里按"站点块"处理，地址取到空字符串，于是界面上会多出一张没有域名、
        // 只装着 email 的卡片，而真正的全局配置（preamble）反而是空的。
        if line == "{" {
            let start = line_no;
            let (_, consumed) = parse_block(&lines, pos);
            pos += consumed;
            for l in &lines[start..pos] {
                preamble_lines.push(l.to_string());
            }
            in_preamble = false;
            pending_marker = None;
            continue;
        }

        if line.contains('{') && !line.starts_with('}') {
            in_preamble = false;
            let addr = line.trim_end_matches('{').trim().to_string();
            let (directives, consumed) = parse_block(&lines, pos);
            pos += consumed;

            // 块后面紧跟着 END 标记 → 这是面板管的段。
            let mut end_line = pos - 1;
            let mut managed = false;
            if pos < lines.len() && lines[pos].trim().starts_with(MARK_END) {
                end_line = pos;
                pos += 1;
                managed = true;
            }
            // 前面有 BEGIN 标记、地址还对得上 → 连标记一起算进这一段。
            let mut start_line = line_no;
            if let Some((marker_line, marker_addr)) = pending_marker.take() {
                if marker_addr == addr {
                    start_line = marker_line;
                    managed = true;
                }
            }

            sites.push(SiteEntry {
                addr,
                directives,
                start_line,
                end_line,
                managed,
            });
        } else if in_preamble {
            preamble_lines.push(lines[line_no].to_string());
        }
    }

    Caddyfile {
        sites,
        preamble: preamble_lines.join("\n"),
    }
}

/// 把一段站点配置包上标记。
pub fn mark_block(addr: &str, body: &str) -> String {
    format!(
        "{MARK_BEGIN} {addr}\n{}\n{MARK_END} {addr}",
        body.trim_end()
    )
}

/// 同一份配置里重复出现的地址。
///
/// Caddy 遇到两个同名站点会拒绝加载，而那一刻**所有**站点一起下线 —— 所以宁可
/// 在保存前拦住。地址按小写比对：`Example.com` 和 `example.com` 在 Caddy 眼里
/// 是同一个站点。
pub fn duplicate_addrs(cf: &Caddyfile) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut dupes = Vec::new();
    for site in &cf.sites {
        let key = site.addr.trim().to_lowercase();
        if !seen.insert(key) && !dupes.contains(&site.addr) {
            dupes.push(site.addr.clone());
        }
    }
    dupes
}

/// 按行范围把某一段切掉。标记行也一起切，不留孤立的 `# ZOPS:BEGIN`。
pub fn remove_site(raw: &str, addr: &str) -> Result<String, String> {
    let cf = parse_caddyfile(raw);
    let Some(site) = cf.sites.iter().find(|s| s.addr == addr) else {
        return Err(format!("配置里找不到 `{addr}` 这一段"));
    };

    let lines: Vec<&str> = raw.lines().collect();
    let kept: Vec<&str> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| *i < site.start_line || *i > site.end_line)
        .map(|(_, l)| *l)
        .collect();
    Ok(tidy(&kept.join("\n")))
}

/// 收尾：去掉行尾空白、把三行以上的空行压成两行、保证以换行结束。
///
/// 删掉一段之后原地会留下两个空行；不管的话反复增删几次，文件里就全是空行了。
fn tidy(raw: &str) -> String {
    let mut out = String::new();
    let mut blanks = 0;
    for line in raw.lines() {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks > 2 {
                continue;
            }
        } else {
            blanks = 0;
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    // 结尾最多留一个空行
    while out.ends_with("\n\n") {
        out.pop();
    }
    out
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

        if trimmed.ends_with('{') {
            let key_args: Vec<&str> = trimmed
                .trim_end_matches('{')
                .trim()
                .split_whitespace()
                .collect();
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

#[allow(dead_code)]
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

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
{
\temail admin@example.com
}

hand.example.com {
\treverse_proxy localhost:4000
}

# ZOPS:BEGIN shop.example.com
shop.example.com {
\treverse_proxy localhost:3307
}
# ZOPS:END shop.example.com
";

    #[test]
    fn 认出标记段落和行范围() {
        let cf = parse_caddyfile(SAMPLE);
        assert_eq!(cf.sites.len(), 2);
        assert!(!cf.sites[0].managed, "手写的块不该算面板管的");
        assert!(cf.sites[1].managed);
        // 范围要连标记行一起包住，删的时候才不会留下孤立的 # ZOPS:BEGIN
        let lines: Vec<&str> = SAMPLE.lines().collect();
        assert!(lines[cf.sites[1].start_line].starts_with("# ZOPS:BEGIN"));
        assert!(lines[cf.sites[1].end_line].starts_with("# ZOPS:END"));
        // 全局选项块要进 preamble，不能当成站点
        assert!(cf.preamble.contains("admin@example.com"));
    }

    #[test]
    fn 查得出重复的地址_大小写不敏感() {
        let raw = format!("{SAMPLE}\nShop.Example.com {{\n\treverse_proxy localhost:1\n}}\n");
        let dupes = duplicate_addrs(&parse_caddyfile(&raw));
        assert_eq!(dupes.len(), 1);
        assert!(dupes[0].eq_ignore_ascii_case("shop.example.com"));

        assert!(duplicate_addrs(&parse_caddyfile(SAMPLE)).is_empty());
    }

    #[test]
    fn 删一段只动这一段() {
        let out = remove_site(SAMPLE, "shop.example.com").unwrap();
        assert!(!out.contains("shop.example.com"));
        assert!(!out.contains("ZOPS:BEGIN"), "标记要跟着走");
        // 别的站点和全局选项一个字都不能少
        assert!(out.contains("hand.example.com"));
        assert!(out.contains("admin@example.com"));
        assert!(parse_caddyfile(&out).sites.len() == 1);
    }

    #[test]
    fn 删不存在的段会报错而不是乱切() {
        assert!(remove_site(SAMPLE, "nope.example.com").is_err());
    }

    #[test]
    fn 增删几轮不会堆出一片空行() {
        let mut raw = SAMPLE.to_string();
        for i in 0..5 {
            let addr = format!("t{i}.example.com");
            raw = format!(
                "{}\n\n{}\n",
                raw.trim_end(),
                mark_block(&addr, &format!("{addr} {{\n\treverse_proxy localhost:{}\n}}", 9000 + i))
            );
        }
        for i in 0..5 {
            raw = remove_site(&raw, &format!("t{i}.example.com")).unwrap();
        }
        assert!(!raw.contains("\n\n\n\n"), "不该留下连续空行：\n{raw}");
        assert_eq!(parse_caddyfile(&raw).sites.len(), 2);
    }
}
