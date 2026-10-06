import {
  NavContainerIcon,
  NavDockerIcon,
  NavFilesIcon,
  NavFirewallIcon,
  NavImagesIcon,
  NavLogViewerIcon,
  NavHomeIcon,
  NavNetIcon,
  NavNetworksIcon,
  NavSettingsIcon,
  NavSitesIcon,
  NavSshIcon,
  NavSwapIcon,
  NavSystemIcon,
  NavTasksIcon,
  NavUpdatesIcon,
  NavUsersIcon,
  NavAgentIcon,
  NavScreenIcon,
  NavNotifyIcon,
  NavDeployIcon,
} from '../components/icons/nav-icons';
import { Perm } from '../lib/permissions';
import {
  buildPermMap,
  type SidebarGroup as SidebarGroupConfig,
  type SidebarParent,
} from '../lib/sidebar-config';

const Icons = {
  NavHomeIcon,
  NavSitesIcon,
  NavSshIcon,
  NavFilesIcon,
  NavLogViewerIcon,
  NavTasksIcon,
  NavDockerIcon,
  NavContainerIcon,
  NavImagesIcon,
  NavNetworksIcon,
  NavSettingsIcon,
  NavSystemIcon,
  NavSwapIcon,
  NavNetIcon,
  NavFirewallIcon,
  NavUpdatesIcon,
  NavUsersIcon,
  NavAgentIcon,
  NavScreenIcon,
  NavNotifyIcon,
  NavDeployIcon,
} as const;

export const SIDEBAR_GROUPS: SidebarGroupConfig[] = [
  {
    labelKey: 'nav.overview',
    items: [
      { path: '/monitor', labelKey: 'nav.monitor', icon: Icons.NavHomeIcon, perm: Perm.NAV_MONITOR },
      { path: '/screen', labelKey: 'nav.screen', icon: Icons.NavScreenIcon, perm: Perm.NAV_SCREEN },
    ],
  },
  {
    labelKey: 'nav.tools',
    items: [
      { path: '/ssh', labelKey: 'nav.ssh', icon: Icons.NavSshIcon, perm: Perm.NAV_SSH },
      { path: '/files', labelKey: 'nav.files', icon: Icons.NavFilesIcon, perm: Perm.NAV_FILES },
      { path: '/deploy', labelKey: 'nav.deploy', icon: Icons.NavDeployIcon, perm: Perm.OPS_DEPLOY },
      { path: '/logs', labelKey: 'nav.logs', icon: Icons.NavLogViewerIcon, perm: Perm.NAV_LOG_VIEWER },
      { path: '/agent', labelKey: 'nav.agent', icon: Icons.NavAgentIcon, perm: Perm.NAV_AGENT },
      { path: '/notify', labelKey: 'nav.notify', icon: Icons.NavNotifyIcon, perm: Perm.NAV_NOTIFY },
    ],
  },
  {
    labelKey: 'nav.automation',
    items: [
      { path: '/automation/tasks', labelKey: 'nav.tasks', icon: Icons.NavTasksIcon, perm: Perm.NAV_AUTOMATION },
    ],
  },
  {
    labelKey: 'nav.workers',
    items: [
      { path: '/sites', labelKey: 'nav.sites', icon: Icons.NavSitesIcon, perm: Perm.NAV_SITES },
      {
        labelKey: 'nav.docker',
        icon: Icons.NavDockerIcon,
        perm: Perm.NAV_DOCKER,
        // 镜像、网络、垃圾、占用、引擎配置都并进了概览页 —— 那样一页能看全，
        // 不用在四个页面之间来回跳；原来那三个子页只有占位图。
        children: [
          { path: '/docker', labelKey: 'docker.overview', icon: Icons.NavDockerIcon, perm: Perm.NAV_DOCKER },
          { path: '/docker/containers', labelKey: 'docker.containers', icon: Icons.NavContainerIcon, perm: Perm.NAV_DOCKER },
        ],
      } as SidebarParent,
    ],
  },
  {
    labelKey: 'nav.system',
    items: [
      {
        labelKey: 'nav.system',
        icon: Icons.NavSystemIcon,
        perm: Perm.NAV_SYSTEM,
        children: [
          { path: '/system/swap', labelKey: 'system.swap', icon: Icons.NavSwapIcon, perm: Perm.NAV_SYSTEM },
          { path: '/system/network', labelKey: 'system.network', icon: Icons.NavNetIcon, perm: Perm.NAV_SYSTEM },
          { path: '/security', labelKey: 'nav.security', icon: Icons.NavFirewallIcon, perm: Perm.NAV_SYSTEM },
          { path: '/system/updates', labelKey: 'system.updates', icon: Icons.NavUpdatesIcon, perm: Perm.NAV_SYSTEM },
        ],
      } as SidebarParent,
      { path: '/members', labelKey: 'nav.members', icon: Icons.NavUsersIcon, perm: Perm.NAV_MEMBERS },

    ],
  },
];

export const PERM_MAP = buildPermMap(SIDEBAR_GROUPS);
