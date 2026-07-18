import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';
import { PageHeader } from '../_components/page-header';
import { PagePlaceholder } from '../_components/page-placeholder';

export default function DockerSettingsPage() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={`${t('docker.title')} / ${t('docker.settings')}`} />
      <PagePlaceholder icon={Settings} title={t('docker.settings')} />
    </div>
  );
}
