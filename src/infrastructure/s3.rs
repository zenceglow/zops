//! S3 兼容的对象上传。亚马逊、阿里云 OSS、Cloudflare R2 都走这一套签名。
//!
//! 只做 PutObject：面板要把一个文件备份上去，不需要列桶、不需要分片。

use std::time::Duration;

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone)]
pub struct PutTarget {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub path_style: bool,
    pub key: String,
}

pub fn put_object(target: &PutTarget, body: Vec<u8>) -> Result<(), String> {
    let url = object_url(target)?;
    let host = url
        .split('/')
        .nth(2)
        .ok_or_else(|| "endpoint 不完整".to_string())?
        .to_string();
    let path = uri_path(&url);
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let payload_hash = sha256_hex(&body);
    let content_type = "application/octet-stream";

    let canonical_headers = format!(
        "content-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    );
    let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";
    let canonical = format!(
        "PUT\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let scope = format!("{date_stamp}/{}/s3/aws4_request", target.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical.as_bytes())
    );
    let signature = sign(&target.secret_key, &date_stamp, &target.region, "s3", &string_to_sign);
    let auth = format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        target.access_key
    );

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .put(&url)
        .header("content-type", content_type)
        .header("x-amz-date", &amz_date)
        .header("x-amz-content-sha256", &payload_hash)
        .header("authorization", auth)
        .body(body)
        .send()
        .map_err(|e| format!("上传失败：{e}"))?;
    if res.status().is_success() {
        Ok(())
    } else {
        let code = res.status();
        let text = res.text().unwrap_or_default();
        let snippet: String = text.chars().take(400).collect();
        Err(format!("对象存储返回 {code}：{snippet}"))
    }
}

pub fn object_url(target: &PutTarget) -> Result<String, String> {
    let endpoint = target.endpoint.trim().trim_end_matches('/');
    if !endpoint.starts_with("https://") && !endpoint.starts_with("http://") {
        return Err("endpoint 要以 http:// 或 https:// 开头".into());
    }
    let host = endpoint
        .split("://")
        .nth(1)
        .ok_or_else(|| "endpoint 不完整".to_string())?;
    let key = aws_encode(&target.key, true);
    if target.path_style {
        Ok(format!("{endpoint}/{}/{}", target.bucket, key.trim_start_matches('/')))
    } else {
        let scheme = endpoint.split("://").next().unwrap_or("https");
        Ok(format!("{scheme}://{}.{host}/{}", target.bucket, key.trim_start_matches('/')))
    }
}

fn uri_path(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    match rest.find('/') {
        Some(i) => rest[i..].to_string(),
        None => "/".into(),
    }
}

fn sign(secret: &str, date: &str, region: &str, service: &str, string_to_sign: &str) -> String {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    hex(&hmac_sha256(&k_signing, string_to_sign.as_bytes()))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

fn aws_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::new();
    for &b in s.as_bytes() {
        let safe = b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'_' | b'.' | b'~')
            || (keep_slash && b == b'/');
        if safe {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// AWS 文档里的 GET 示例，用来钉住签名算法，避免上传时才发现签错。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 文档里的签名对得上() {
        let secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
        let amz_date = "20130524T000000Z";
        let date_stamp = "20130524";
        let region = "us-east-1";
        let payload_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let canonical_headers = format!(
            "host:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
        );
        let signed_headers = "host;range;x-amz-content-sha256;x-amz-date";
        let canonical = format!(
            "GET\n/test.txt\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        let scope = format!("{date_stamp}/{region}/s3/aws4_request");
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            sha256_hex(canonical.as_bytes())
        );
        let signature = sign(secret, date_stamp, region, "s3", &string_to_sign);
        assert_eq!(
            signature,
            "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn path_style把桶放在路径里() {
        let url = object_url(&PutTarget {
            endpoint: "https://abc.r2.cloudflarestorage.com".into(),
            region: "auto".into(),
            bucket: "backup".into(),
            access_key: String::new(),
            secret_key: String::new(),
            path_style: true,
            key: "a/b.txt".into(),
        })
        .unwrap();
        assert_eq!(url, "https://abc.r2.cloudflarestorage.com/backup/a/b.txt");
    }
}
