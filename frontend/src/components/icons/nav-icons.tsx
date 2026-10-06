import type { IconType } from 'react-icons';
import {
  HiHome,
  HiGlobeAlt,
  HiCommandLine,
  HiFolderOpen,
  HiCube,
  HiSquare2Stack,
  HiQueueList,
  HiCog6Tooth,
  HiServerStack,
  HiCircleStack,
  HiWifi,
  HiShieldCheck,
  HiArrowPath,
  HiSun,
  HiMoon,
  HiComputerDesktop,
  HiLanguage,
  HiArrowRightOnRectangle,
  HiUser,
  HiUsers,
  HiChevronRight,
  HiDocumentText,
  HiPlayCircle,
  HiClock,
  HiCpuChip,
  HiChartBarSquare,
  HiBellAlert,
  HiRocketLaunch,
} from 'react-icons/hi2';
import { SiDocker } from 'react-icons/si';
import { cn } from '../../lib/utils';

/**
 * 实心（fill）而不是描边。
 *
 * Dock 里的图标只有 20px 上下，描边风格在这个尺寸下只剩一圈细线，远看像没画
 * 东西——所以整体换成 heroicons 的 solid 版本：同样的字号，视觉重量高得多。
 */
function navIcon(Icon: IconType) {
  return function NavIcon({ className }: { className?: string }) {
    return <Icon className={cn('size-4 shrink-0', className)} aria-hidden />;
  };
}

// 首页那格是"桌面"，图标就用房子：柱状图在这个尺寸下会被读成信号格，
// 而且它描述的是"监控"这个能力，不是"回首页"这个动作。
export const NavHomeIcon = navIcon(HiHome);
// 大屏用柱状图——这一格本来描述的就是"统计"，和首页的"回桌面"不冲突。
export const NavScreenIcon = navIcon(HiChartBarSquare);
export const NavNotifyIcon = navIcon(HiBellAlert);
export const NavSitesIcon = navIcon(HiGlobeAlt);
export const NavSshIcon = navIcon(HiCommandLine);
export const NavFilesIcon = navIcon(HiFolderOpen);
export const NavDockerIcon = navIcon(SiDocker);
export const NavContainerIcon = navIcon(HiCube);
export const NavImagesIcon = navIcon(HiSquare2Stack);
export const NavNetworksIcon = navIcon(HiQueueList);
export const NavSettingsIcon = navIcon(HiCog6Tooth);
export const NavSystemIcon = navIcon(HiServerStack);
export const NavSwapIcon = navIcon(HiCircleStack);
export const NavNetIcon = navIcon(HiWifi);
export const NavFirewallIcon = navIcon(HiShieldCheck);
export const NavUpdatesIcon = navIcon(HiArrowPath);
export const NavSunIcon = navIcon(HiSun);
export const NavMoonIcon = navIcon(HiMoon);
export const NavDesktopIcon = navIcon(HiComputerDesktop);
export const NavLangIcon = navIcon(HiLanguage);
export const NavLogoutIcon = navIcon(HiArrowRightOnRectangle);
export const NavUserIcon = navIcon(HiUser);
export const NavUsersIcon = navIcon(HiUsers);
export const NavChevronIcon = navIcon(HiChevronRight);
export const NavLogViewerIcon = navIcon(HiDocumentText);
export const NavTasksIcon = navIcon(HiPlayCircle);
export const NavClockIcon = navIcon(HiClock);
export const NavAgentIcon = navIcon(HiCpuChip);
export const NavDeployIcon = navIcon(HiRocketLaunch);
