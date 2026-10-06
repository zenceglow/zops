import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Perm } from '../../lib/permissions';
import useUserStore from '../../stores/user.store';

/** 设置菜单里除了跳页面之外的几种弹窗。面板设置页自己处理这些事，这里留着兼容旧入口。 */
export type SettingsDialog = 'timezone' | 'bind-domain' | 'uninstall' | 'contact';

const item = 'rounded-lg px-3 py-2.5 text-sm';

export function SettingsMenu({ trigger }: { trigger: React.ReactNode }) {
  const { t } = useTranslation();
  const hasPermission = useUserStore((s) => s.hasPermission);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="mb-3 min-w-52 p-1.5">
        {hasPermission(Perm.NAV_SYSTEM) && (
          <DropdownMenuItem asChild className={item}>
            <Link to="/settings/system">{t('settings.system')}</Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild className={item}>
          <Link to="/settings/panel">{t('settings.panel')}</Link>
        </DropdownMenuItem>
        {hasPermission(Perm.NAV_DOCKER) && (
          <DropdownMenuItem asChild className={item}>
            <Link to="/docker">{t('settings.docker')}</Link>
          </DropdownMenuItem>
        )}
        {hasPermission(Perm.NAV_SITES) && (
          <DropdownMenuItem asChild className={item}>
            <Link to="/sites">{t('settings.caddy')}</Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild className={item}>
          <Link to="/about">{t('settings.about')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
