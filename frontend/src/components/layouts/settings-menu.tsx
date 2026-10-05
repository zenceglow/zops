import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Clock,
  ExternalLink,
  Globe,
  HardDrive,
  Mail,
  Package,
  RefreshCw,
  Terminal,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { cn } from '../../lib/utils';
import useUserStore from '../../stores/user.store';

/** 设置菜单里除了跳页面之外的几种弹窗。 */
export type SettingsDialog = 'timezone' | 'bind-domain' | 'uninstall' | 'contact';

export function SettingsMenu({
  trigger,
  onDialog,
  navSystem,
}: {
  trigger: React.ReactNode;
  onDialog: (which: SettingsDialog) => void;
  /** 没有 system 权限就只留"面板设置"。 */
  navSystem: boolean;
}) {
  const { t } = useTranslation();
  const isSuper = useUserStore((s) => s.user?.role === 'super_admin');

  const item = 'gap-2.5 text-sm';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="mb-3 min-w-52">
        {navSystem && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t('settings.system')}
            </DropdownMenuLabel>
            <DropdownMenuItem asChild className={item}>
              <Link to="/system/swap">
                <HardDrive className="size-4" />
                {t('system.swap')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem className={item} onSelect={() => onDialog('timezone')}>
              <Clock className="size-4" />
              {t('system.timezone')}
            </DropdownMenuItem>
            <DropdownMenuItem asChild className={item}>
              <Link to="/system/network">
                <Globe className="size-4" />
                {t('system.network')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className={item}>
              <Link to="/system/updates">
                <RefreshCw className="size-4" />
                {t('system.updates')}
              </Link>
            </DropdownMenuItem>
            {/* 定时任务从 Dock 上撤了，但它还得有入口 —— 没入口的页面等于不存在。 */}
            <DropdownMenuItem asChild className={item}>
              <Link to="/automation/tasks">
                <Terminal className="size-4" />
                {t('nav.tasks')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t('settings.panel')}
        </DropdownMenuLabel>
        <DropdownMenuItem className={item} onSelect={() => onDialog('bind-domain')}>
          <Package className="size-4" />
          {t('settings.bind_domain')}
        </DropdownMenuItem>
        <DropdownMenuItem className={item} onSelect={() => onDialog('contact')}>
          <Mail className="size-4" />
          {t('settings.contact')}
        </DropdownMenuItem>
        {/* 卸载是 irreversible 的，只有超管能看到入口。 */}
        {isSuper && (
          <DropdownMenuItem
            className={cn(item, 'text-destructive')}
            onSelect={() => onDialog('uninstall')}
          >
            <Trash2 className="size-4" />
            {t('settings.uninstall')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className={item}>
          <a href="https://github.com/zenceglow/zops" target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" />
            {t('settings.source')}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
