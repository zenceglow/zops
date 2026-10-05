import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Globe, HardDrive, RefreshCw, Terminal } from 'lucide-react';
import { SettingsRow } from '../_components/settings-row';
import { SettingsDialogs } from '../../../components/layouts/settings-dialogs';
import type { SettingsDialog } from '../../../components/layouts/settings-menu';

/**
 * 系统设置。
 *
 * 从 Dock 的"设置"进来之后才摊开这些项 —— 一个下拉菜单塞八九条，等于没分组。
 */
export default function SystemSettingsPage() {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<SettingsDialog | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.system')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('settings.system_desc')}</p>
      </div>

      <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60">
        <SettingsRow
          icon={HardDrive}
          label={t('system.swap')}
          desc={t('settings.swap_desc')}
          to="/system/swap"
        />
        <SettingsRow
          icon={Clock}
          label={t('system.timezone')}
          desc={t('settings.timezone_row_desc')}
          onClick={() => setDialog('timezone')}
        />
        <SettingsRow
          icon={Globe}
          label={t('system.network')}
          desc={t('settings.network_desc')}
          to="/system/network"
        />
        <SettingsRow
          icon={RefreshCw}
          label={t('system.updates')}
          desc={t('settings.updates_desc')}
          to="/system/updates"
        />
        <SettingsRow
          icon={Terminal}
          label={t('nav.tasks')}
          desc={t('settings.tasks_desc')}
          to="/automation/tasks"
        />
      </div>

      <SettingsDialogs open={dialog} onOpenChange={setDialog} />
    </div>
  );
}
