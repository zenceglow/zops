import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Package, SlidersHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

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

  const item = 'gap-2.5 text-sm';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="mb-3 min-w-44">
        {/* 这里只放两个入口，具体设置进页面再摊开 —— 一个下拉里塞八九条等于没分组。 */}
        {navSystem && (
          <DropdownMenuItem asChild className={item}>
            <Link to="/settings/system">
              <SlidersHorizontal className="size-4" />
              {t('settings.system')}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild className={item}>
          <Link to="/settings/panel">
            <Package className="size-4" />
            {t('settings.panel')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
