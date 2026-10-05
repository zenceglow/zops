import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Mail, Package, Trash2 } from 'lucide-react';
import { SettingsRow } from '../_components/settings-row';
import { SettingsDialogs } from '../../../components/layouts/settings-dialogs';
import type { SettingsDialog } from '../../../components/layouts/settings-menu';
import useUserStore from '../../../stores/user.store';

export default function PanelSettingsPage() {
  const { t } = useTranslation();
  const isSuper = useUserStore((s) => s.user?.role === 'super_admin');
  const [dialog, setDialog] = useState<SettingsDialog | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.panel')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('settings.panel_desc')}</p>
      </div>

      <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60">
        <SettingsRow
          icon={Package}
          label={t('settings.bind_domain')}
          desc={t('settings.bind_row_desc')}
          onClick={() => setDialog('bind-domain')}
        />
        <SettingsRow
          icon={Mail}
          label={t('settings.contact')}
          desc={t('settings.contact_row_desc')}
          onClick={() => setDialog('contact')}
        />
        <SettingsRow
          icon={ExternalLink}
          label={t('settings.source')}
          desc={t('settings.source_desc')}
          href="https://github.com/zenceglow/zops"
        />
        {/* 卸载只有超管可见，而且永远放在最后一项。 */}
        {isSuper && (
          <SettingsRow
            icon={Trash2}
            label={t('settings.uninstall')}
            desc={t('settings.uninstall_row_desc')}
            onClick={() => setDialog('uninstall')}
            danger
          />
        )}
      </div>

      <SettingsDialogs open={dialog} onOpenChange={setDialog} />
    </div>
  );
}
