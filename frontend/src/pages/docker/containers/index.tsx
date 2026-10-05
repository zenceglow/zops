import { useTranslation } from 'react-i18next';
import { Container, Server } from 'lucide-react';
import { PageHeader } from './_components/page-header';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';
import { useContainers } from './_hooks';

/**
 * 容器明细。
 *
 * 首页只留一排 chip（名字 + 运行状态），镜像与端口映射放这里 ——
 * 排查 502 时需要知道上游容器在监听什么端口，那是首页不该承担的密度。
 */
export default function Page() {
  const { t } = useTranslation();
  const { containers, docker, loading } = useContainers();

  return (
    <div>
      <PageHeader
        title={`${t('docker.title')} / ${t('docker.containers')}`}
        actions={
          docker ? (
            <Badge variant={docker.available ? 'default' : 'secondary'}>
              {docker.available ? `v${docker.version}` : t('docker.not_installed')}
            </Badge>
          ) : null
        }
      />

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : !docker?.available ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Server className="mx-auto mb-3 size-8 text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground">{t('docker.not_installed')}</p>
            <p className="mt-1 text-xs text-muted-foreground/70">{t('docker.install_hint')}</p>
          </CardContent>
        </Card>
      ) : containers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Container className="mx-auto mb-3 size-8 text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground">{t('docker.no_containers')}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('docker.name')}</TableHead>
                <TableHead>{t('docker.image')}</TableHead>
                <TableHead>{t('docker.status')}</TableHead>
                <TableHead>{t('docker.ports')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {containers.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {c.image}
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.state === 'running' ? 'default' : 'secondary'}>
                      {c.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.ports || '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
