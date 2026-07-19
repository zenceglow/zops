import { useTranslation } from 'react-i18next';

export default function FilesPage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">{t('files.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('files.subtitle')}</p>
      </div>
      <div className="rounded-xl border border-dashed border-sidebar-border p-12 text-center text-sm text-muted-foreground">
        {t('files.subtitle')}
      </div>
    </div>
  );
}
