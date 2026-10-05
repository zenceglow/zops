use serde::{Deserialize, Serialize};

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
pub struct CaddyfileData {
    pub raw: String,
    pub parsed: Caddyfile,
}

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

        // 顶部的全局选项块：整份 Caddyfile 只有一个，写法就是光秃秃一个 `{`。
        // 之前这里按"站点块"处理，地址取到空字符串，于是界面上会多出一张没有域名、
        // 只装着 email 的卡片，而真正的全局配置（preamble）反而是空的。
        if line == "{" {
            let start = pos - 1;
            let (_, consumed) = parse_block(&lines, pos);
            pos += consumed;
            for l in &lines[start..pos] {
                preamble_lines.push(l.to_string());
            }
            in_preamble = false;
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
