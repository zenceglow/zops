import { useTranslation } from 'react-i18next';
import { MemoryStick } from 'lucide-react';
import { PageHeader } from './_components/page-header';
import { PagePlaceholder } from './_components/page-placeholder';

export default function Page() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={`${t('system.title')} / ${t('system.swap')}`} />
      <PagePlaceholder
        icon={MemoryStick}
        title={t('system.swap')}
        description={t('system.swap_desc')}
      />
    </div>
  );
}
