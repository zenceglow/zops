import { useTranslation } from 'react-i18next';
import { Network } from 'lucide-react';
import { PageHeader } from '../_components/page-header';
import { PagePlaceholder } from '../_components/page-placeholder';

export default function DockerNetworksPage() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={`${t('docker.title')} / ${t('docker.networks')}`} />
      <PagePlaceholder icon={Network} title={t('docker.networks')} />
    </div>
  );
}
