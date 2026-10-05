use std::sync::Arc;

use crate::service::{
    auth::AuthService, automation::AutomationService, caddyfile::CaddyfileService,
    container::ContainerService,
    files::FilesService,
    gateway::GatewayService, logs::LogService, member::MemberService, setup::SetupService,
    system::SystemService,
    token::TokenService,
};

pub struct AppState {
    pub auth: Arc<AuthService>,
    pub setup: Arc<SetupService>,
    pub system: Arc<SystemService>,
    pub containers: Arc<ContainerService>,
    pub files: Arc<FilesService>,
    pub gateway: Arc<GatewayService>,
    pub caddyfile: Arc<CaddyfileService>,
    pub logs: Arc<LogService>,
    pub members: Arc<MemberService>,
    pub automation: Arc<AutomationService>,
    /// Agent access tokens (MCP / skills). Verified by `handlers::mcp`.
    pub tokens: Arc<TokenService>,
}
