import { useTranslation } from 'react-i18next';
import { Package } from 'lucide-react';
import { PageHeader } from './_components/page-header';
import { PagePlaceholder } from './_components/page-placeholder';

export default function Page() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={`${t('system.title')} / ${t('system.updates')}`} />
      <PagePlaceholder
        icon={Package}
        title={t('system.updates')}
        description={t('system.updates_desc')}
      />
    </div>
  );
}
