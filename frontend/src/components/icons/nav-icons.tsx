import type { IconType } from 'react-icons';
import {
  HiOutlineChartBar,
  HiOutlineGlobeAlt,
  HiOutlineCommandLine,
  HiOutlineFolderOpen,
  HiOutlineCube,
  HiOutlineSquare2Stack,
  HiOutlineQueueList,
  HiOutlineCog6Tooth,
  HiOutlineServerStack,
  HiOutlineCircleStack,
  HiOutlineWifi,
  HiOutlineShieldCheck,
  HiOutlineArrowPath,
  HiOutlineSun,
  HiOutlineMoon,
  HiOutlineComputerDesktop,
  HiOutlineLanguage,
  HiOutlineArrowRightOnRectangle,
  HiOutlineUser,
  HiOutlineUsers,
  HiOutlineChevronRight,
  HiOutlineDocumentText,
  HiOutlinePlayCircle,
  HiOutlineClock,
  HiOutlineCpuChip,
} from 'react-icons/hi2';
import { SiDocker } from 'react-icons/si';
import { cn } from '../../lib/utils';

function navIcon(Icon: IconType) {
  return function NavIcon({ className }: { className?: string }) {
    return <Icon className={cn('size-4 shrink-0', className)} aria-hidden />;
  };
}

export const NavMonitorIcon = navIcon(HiOutlineChartBar);
export const NavSitesIcon = navIcon(HiOutlineGlobeAlt);
export const NavSshIcon = navIcon(HiOutlineCommandLine);
export const NavFilesIcon = navIcon(HiOutlineFolderOpen);
export const NavDockerIcon = navIcon(SiDocker);
export const NavContainerIcon = navIcon(HiOutlineCube);
export const NavImagesIcon = navIcon(HiOutlineSquare2Stack);
export const NavNetworksIcon = navIcon(HiOutlineQueueList);
export const NavSettingsIcon = navIcon(HiOutlineCog6Tooth);
export const NavSystemIcon = navIcon(HiOutlineServerStack);
export const NavSwapIcon = navIcon(HiOutlineCircleStack);
export const NavNetIcon = navIcon(HiOutlineWifi);
export const NavFirewallIcon = navIcon(HiOutlineShieldCheck);
export const NavUpdatesIcon = navIcon(HiOutlineArrowPath);
export const NavSunIcon = navIcon(HiOutlineSun);
export const NavMoonIcon = navIcon(HiOutlineMoon);
export const NavDesktopIcon = navIcon(HiOutlineComputerDesktop);
export const NavLangIcon = navIcon(HiOutlineLanguage);
export const NavLogoutIcon = navIcon(HiOutlineArrowRightOnRectangle);
export const NavUserIcon = navIcon(HiOutlineUser);
export const NavUsersIcon = navIcon(HiOutlineUsers);
export const NavChevronIcon = navIcon(HiOutlineChevronRight);
export const NavLogViewerIcon = navIcon(HiOutlineDocumentText);
export const NavTasksIcon = navIcon(HiOutlinePlayCircle);
export const NavClockIcon = navIcon(HiOutlineClock);
export const NavAgentIcon = navIcon(HiOutlineCpuChip);
