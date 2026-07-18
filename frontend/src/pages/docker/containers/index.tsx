import { useTranslation } from 'react-i18next';
import { Container } from 'lucide-react';
import { PageHeader } from './_components/page-header';
import { PagePlaceholder } from './_components/page-placeholder';

export default function Page() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={`${t('docker.title')} / ${t('docker.containers')}`} />
      <PagePlaceholder
        icon={Container}
        title={t('docker.containers')}
      />
    </div>
  );
}
