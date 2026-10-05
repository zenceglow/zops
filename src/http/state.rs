use std::sync::Arc;

use crate::service::{
    analytics::AnalyticsService,
    audit::AuditService,
    auth::AuthService, automation::AutomationService, caddyfile::CaddyfileService,
    container::ContainerService,
    deploy::DeployService,
    files::FilesService,
    gateway::GatewayService, logs::LogService, member::MemberService,
    notify::NotifyService, setup::SetupService,
    system::SystemService,
    token::TokenService,
};

pub struct AppState {
    pub analytics: Arc<AnalyticsService>,
    pub audit: Arc<AuditService>,
    pub auth: Arc<AuthService>,
    pub setup: Arc<SetupService>,
    pub system: Arc<SystemService>,
    pub containers: Arc<ContainerService>,
    pub deploy: Arc<DeployService>,
    pub files: Arc<FilesService>,
    pub gateway: Arc<GatewayService>,
    pub caddyfile: Arc<CaddyfileService>,
    pub logs: Arc<LogService>,
    pub members: Arc<MemberService>,
    pub notify: Arc<NotifyService>,
    pub automation: Arc<AutomationService>,
    /// Agent access tokens (MCP / skills). Verified by `handlers::mcp`.
    pub tokens: Arc<TokenService>,
}
