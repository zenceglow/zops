import { useTranslation } from 'react-i18next';
import { Network } from 'lucide-react';
import { PageHeader } from './_components/page-header';
import { PagePlaceholder } from './_components/page-placeholder';

export default function Page() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={`${t('system.title')} / ${t('system.network')}`} />
      <PagePlaceholder
        icon={Network}
        title={t('system.network')}
      />
    </div>
  );
}
