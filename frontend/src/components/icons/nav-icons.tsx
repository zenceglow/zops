import type { IconType } from 'react-icons';
import {
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
  HiChartBar,
  HiPresentationChartLine,
  HiBellAlert,
  HiRocketLaunch,
  HiSquares2X2,
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

/** 首页：实心、没有门窗和烟囱，20px 上比完整房子干净。 */
export function NavHomeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-4 shrink-0', className)} fill="currentColor" aria-hidden>
      <path d="M12 3.4 3.2 11.2h2.3V20h5.2v-5.1h2.6V20h5.2v-8.8h2.3L12 3.4Z" />
    </svg>
  );
}
/**
 * 大屏用"演示屏"，统计用"柱状图"。
 *
 * 这两格原来共用 HiChartBarSquare，Dock 只显图标时全靠位置和悬停名字分辨，谁看
 * 都是同一个方块。按各自的含义拆开：大屏是"投在墙上的那一块"（演示屏），访问统计
 * 才是"统计本身"（柱状图）—— 柱状图归统计，名实相符。
 */
export const NavScreenIcon = navIcon(HiPresentationChartLine);
/** 访问统计：柱状图。见上面 NavScreenIcon 的说明。 */
export const NavAnalyticsIcon = navIcon(HiChartBar);
/** 应用市场：九宫格里挑一个装。 */
export const NavMarketIcon = navIcon(HiSquares2X2);
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
