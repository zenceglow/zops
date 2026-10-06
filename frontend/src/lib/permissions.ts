/**
 * Well-known permission IDs & role constants.
 *
 * These string constants mirror the backend's domain/permission.rs catalog.
 * The authoritative list is fetched from GET /permission/list at boot time
 * and stored in permission.store.ts.  Every ID here MUST exist in that
 * server response — if you add a new permission to the backend, add the
 * corresponding constant here so the sidebar / route guards can reference it.
 */

export const Perm = {
  NAV_MONITOR: 'nav.monitor',
  NAV_SCREEN: 'nav.screen',
  NAV_SITES: 'nav.sites',
  NAV_SSH: 'nav.ssh',
  NAV_DOCKER: 'nav.docker',
  NAV_SYSTEM: 'nav.system',
  NAV_MEMBERS: 'nav.members',
  NAV_FILES: 'nav.files',
  NAV_LOG_VIEWER: 'nav.logs',
  NAV_AUTOMATION: 'nav.automation',
  NAV_AGENT: 'nav.agent',
  NAV_NOTIFY: 'nav.notify',
  OPS_SYSTEM_READ: 'ops.system.read',
  OPS_SERVICE_READ: 'ops.service.read',
  OPS_SERVICE_CONTROL: 'ops.service.control',
  OPS_SERVICE_LOG: 'ops.service.log',
  OPS_GATEWAY_READ: 'ops.gateway.read',
  OPS_GATEWAY_CONTROL: 'ops.gateway.control',
  OPS_GATEWAY_WRITE: 'ops.gateway.write',
  OPS_LOG_READ: 'ops.log.read',
  OPS_SSH_CONNECT: 'ops.ssh.connect',
  OPS_MEMBER_MANAGE: 'ops.member.manage',
  OPS_AUTOMATION_MANAGE: 'ops.automation.manage',
  OPS_AGENT_MANAGE: 'ops.agent.manage',
  OPS_NOTIFY_MANAGE: 'ops.notify.manage',
  OPS_DEPLOY: 'ops.deploy',
} as const;

export type PermissionId = (typeof Perm)[keyof typeof Perm];

export const ROLE_SUPER_ADMIN = 'super_admin';
export const ROLE_MEMBER = 'member';
