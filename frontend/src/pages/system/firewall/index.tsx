import { useTranslation } from 'react-i18next';
import { Shield } from 'lucide-react';
import { PageHeader } from './_components/page-header';
import { PagePlaceholder } from './_components/page-placeholder';

export default function Page() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={`${t('system.title')} / ${t('system.firewall')}`} />
      <PagePlaceholder
        icon={Shield}
        title={t('system.firewall')}
        description={t('system.firewall_desc')}
      />
    </div>
  );
}
