//! RBAC permission catalog and helpers.

use serde::Serialize;

/// Built-in roles.
pub const ROLE_SUPER_ADMIN: &str = "super_admin";
pub const ROLE_MEMBER: &str = "member";

/// Sidebar permissions.
pub const NAV_MONITOR: &str = "nav.monitor";
pub const NAV_SITES: &str = "nav.sites";
pub const NAV_SSH: &str = "nav.ssh";
pub const NAV_DOCKER: &str = "nav.docker";
pub const NAV_SYSTEM: &str = "nav.system";
pub const NAV_MEMBERS: &str = "nav.members";
pub const NAV_FILES: &str = "nav.files";

/// Operation permissions.
pub const OPS_SYSTEM_READ: &str = "ops.system.read";
/// 装系统补丁。比"读"危险一档：会真的改动主机上的软件包，所以单独一个权限。
pub const OPS_SYSTEM_WRITE: &str = "ops.system.write";
pub const OPS_SERVICE_READ: &str = "ops.service.read";
pub const OPS_SERVICE_CONTROL: &str = "ops.service.control";
pub const OPS_SERVICE_LOG: &str = "ops.service.log";
pub const OPS_GATEWAY_READ: &str = "ops.gateway.read";
pub const OPS_GATEWAY_CONTROL: &str = "ops.gateway.control";
pub const OPS_GATEWAY_WRITE: &str = "ops.gateway.write";
pub const OPS_LOG_READ: &str = "ops.log.read";
/// 浏览文件系统。只读 —— 面板里能看日志、能开 SSH 终端，这一项不该更弱也不该更强。
pub const OPS_FILES_READ: &str = "ops.files.read";
pub const OPS_SSH_CONNECT: &str = "ops.ssh.connect";
pub const OPS_MEMBER_MANAGE: &str = "ops.member.manage";
pub const OPS_AUTOMATION_MANAGE: &str = "ops.automation.manage";

/// Additional navigation permissions.
pub const NAV_LOG_VIEWER: &str = "nav.logs";
pub const NAV_AUTOMATION: &str = "nav.automation";
/// "接入 Codex" page: MCP endpoint + agent tokens + skill install.
pub const NAV_AGENT: &str = "nav.agent";

/// Manage programmatic access tokens (MCP / skills) and read the skill pack.
pub const OPS_AGENT_MANAGE: &str = "ops.agent.manage";

#[derive(Debug, Clone, Serialize)]
pub struct PermissionDef {
    pub id: &'static str,
    pub group: &'static str,
}

/// Full catalog for `GET /api/ops/permission/list`.
pub fn all_permissions() -> Vec<PermissionDef> {
    vec![
        PermissionDef {
            id: NAV_MONITOR,
            group: "nav",
        },
        PermissionDef {
            id: NAV_SITES,
            group: "nav",
        },
        PermissionDef {
            id: NAV_SSH,
            group: "nav",
        },
        PermissionDef {
            id: NAV_DOCKER,
            group: "nav",
        },
        PermissionDef {
            id: NAV_SYSTEM,
            group: "nav",
        },
        PermissionDef {
            id: NAV_MEMBERS,
            group: "nav",
        },
        PermissionDef {
            id: NAV_FILES,
            group: "nav",
        },
        PermissionDef {
            id: NAV_LOG_VIEWER,
            group: "nav",
        },
        PermissionDef {
            id: NAV_AUTOMATION,
            group: "nav",
        },
        PermissionDef {
            id: NAV_AGENT,
            group: "nav",
        },
        PermissionDef {
            id: OPS_SYSTEM_READ,
            group: "ops",
        },
        PermissionDef {
            id: OPS_SYSTEM_WRITE,
            group: "ops",
        },
        PermissionDef {
            id: OPS_SERVICE_READ,
            group: "ops",
        },
        PermissionDef {
            id: OPS_SERVICE_CONTROL,
            group: "ops",
        },
        PermissionDef {
            id: OPS_SERVICE_LOG,
            group: "ops",
        },
        PermissionDef {
            id: OPS_GATEWAY_READ,
            group: "ops",
        },
        PermissionDef {
            id: OPS_GATEWAY_CONTROL,
            group: "ops",
        },
        PermissionDef {
            id: OPS_GATEWAY_WRITE,
            group: "ops",
        },
        PermissionDef {
            id: OPS_LOG_READ,
            group: "ops",
        },
        PermissionDef {
            id: OPS_FILES_READ,
            group: "ops",
        },
        PermissionDef {
            id: OPS_SSH_CONNECT,
            group: "ops",
        },
        PermissionDef {
            id: OPS_MEMBER_MANAGE,
            group: "ops",
        },
        PermissionDef {
            id: OPS_AUTOMATION_MANAGE,
            group: "ops",
        },
        PermissionDef {
            id: OPS_AGENT_MANAGE,
            group: "ops",
        },
    ]
}

pub fn all_permission_ids() -> Vec<&'static str> {
    all_permissions().into_iter().map(|p| p.id).collect()
}

pub fn is_known_permission(id: &str) -> bool {
    all_permission_ids().contains(&id)
}

pub fn is_valid_role(role: &str) -> bool {
    role == ROLE_SUPER_ADMIN || role == ROLE_MEMBER
}
