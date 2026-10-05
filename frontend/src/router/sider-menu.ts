import {
  NavContainerIcon,
  NavDockerIcon,
  NavFilesIcon,
  NavFirewallIcon,
  NavImagesIcon,
  NavLogViewerIcon,
  NavMonitorIcon,
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
} from '../components/icons/nav-icons';
import { Perm } from '../lib/permissions';
import {
  buildPermMap,
  type SidebarGroup as SidebarGroupConfig,
  type SidebarParent,
} from '../lib/sidebar-config';

const Icons = {
  NavMonitorIcon,
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
} as const;

export const SIDEBAR_GROUPS: SidebarGroupConfig[] = [
  {
    labelKey: 'nav.overview',
    items: [
      { path: '/monitor', labelKey: 'nav.monitor', icon: Icons.NavMonitorIcon, perm: Perm.NAV_MONITOR },
    ],
  },
  {
    labelKey: 'nav.tools',
    items: [
      { path: '/ssh', labelKey: 'nav.ssh', icon: Icons.NavSshIcon, perm: Perm.NAV_SSH },
      { path: '/files', labelKey: 'nav.files', icon: Icons.NavFilesIcon, perm: Perm.NAV_FILES },
      { path: '/logs', labelKey: 'nav.logs', icon: Icons.NavLogViewerIcon, perm: Perm.NAV_LOG_VIEWER },
      { path: '/agent', labelKey: 'nav.agent', icon: Icons.NavAgentIcon, perm: Perm.NAV_AGENT },
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
        children: [
          { path: '/docker/containers', labelKey: 'docker.containers', icon: Icons.NavContainerIcon, perm: Perm.NAV_DOCKER },
          { path: '/docker/images', labelKey: 'docker.images', icon: Icons.NavImagesIcon, perm: Perm.NAV_DOCKER },
          { path: '/docker/networks', labelKey: 'docker.networks', icon: Icons.NavNetworksIcon, perm: Perm.NAV_DOCKER },
          { path: '/docker/settings', labelKey: 'docker.settings', icon: Icons.NavSettingsIcon, perm: Perm.NAV_DOCKER },
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
          { path: '/system/firewall', labelKey: 'system.firewall', icon: Icons.NavFirewallIcon, perm: Perm.NAV_SYSTEM },
          { path: '/system/updates', labelKey: 'system.updates', icon: Icons.NavUpdatesIcon, perm: Perm.NAV_SYSTEM },
        ],
      } as SidebarParent,
      { path: '/members', labelKey: 'nav.members', icon: Icons.NavUsersIcon, perm: Perm.NAV_MEMBERS },

    ],
  },
];

export const PERM_MAP = buildPermMap(SIDEBAR_GROUPS);
