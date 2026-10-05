//! API tokens: long-lived credentials for programmatic access (MCP, skills).

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::permission::{
    all_permission_ids, OPS_GATEWAY_READ, OPS_LOG_READ, OPS_SERVICE_LOG, OPS_SERVICE_READ,
    OPS_SYSTEM_READ,
};

/// Token scopes. Deliberately coarse: a per-permission picker on top of the
/// existing member RBAC would become a second, subtly different permission
/// system, and the thing that actually matters for an agent token is
/// "can it change the server, or only look at it".
pub const SCOPE_READ: &str = "read";
pub const SCOPE_WRITE: &str = "write";

pub fn is_valid_scope(scope: &str) -> bool {
    scope == SCOPE_READ || scope == SCOPE_WRITE
}

/// Everything an agent needs to *look* at a server, and nothing that can
/// change it. Note `ops.automation.manage` is intentionally absent: it gates
/// cron task creation, and there is no read-only automation permission yet.
pub fn read_scope_permissions() -> Vec<String> {
    [
        OPS_SYSTEM_READ,
        OPS_SERVICE_READ,
        OPS_SERVICE_LOG,
        OPS_GATEWAY_READ,
        OPS_LOG_READ,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Full operator rights (same catalog as a super admin's effective set).
pub fn write_scope_permissions() -> Vec<String> {
    all_permission_ids().into_iter().map(|s| s.to_string()).collect()
}

pub fn permissions_for_scope(scope: &str) -> Vec<String> {
    if scope == SCOPE_READ {
        read_scope_permissions()
    } else {
        write_scope_permissions()
    }
}

pub const TOKEN_PREFIX: &str = "ops_";

/// `ops_` + 64 hex chars (two UUIDv4s ≈ 244 bits of entropy).
pub fn generate_token() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{TOKEN_PREFIX}{a}{b}")
}

/// Only the hash is ever persisted. SHA-256 (not Argon2) is the right tool
/// here: the token is high-entropy machine-generated, so there is nothing to
/// brute-force, and this runs on every MCP request.
pub fn hash_token(plain: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(plain.as_bytes());
    hex_encode(&hasher.finalize())
}

/// First few characters, kept for display so an operator can tell two tokens
/// apart without ever seeing the secret again.
pub fn token_prefix(plain: &str) -> String {
    plain.chars().take(12).collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct ApiTokenInfo {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub scope: String,
    pub permissions: Vec<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
}

/// Returned exactly once, at creation time — the plaintext is never stored.
#[derive(Debug, Clone, Serialize)]
pub struct ApiTokenCreated {
    pub token: String,
    #[serde(flatten)]
    pub info: ApiTokenInfo,
}
