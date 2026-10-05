import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import { PageHeader } from './_components/page-header';
import { NetworkSparkline } from '../../../components/network-sparkline';
import { formatRate, useNetworkRate } from '../../../hooks/use-network-rate';
import { Card, CardContent } from '../../../components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';
import { formatBytes } from '../../monitor/_hooks/use-monitor';

function BigRate({ label, value, total }: { label: string; value: string; total: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-2 text-3xl font-semibold leading-none tabular-nums">{value}</div>
      <div className="mt-2 text-xs text-muted-foreground tabular-nums">{total}</div>
    </div>
  );
}

/**
 * 网络页：首页挂件点进来之后的明细。
 *
 * 每 2 秒采样一次累计计数器做差分，所以速率是"最近一次采样窗口"的瞬时值；
 * 累计值则是自开机以来的总量 —— 两者标清楚，免得被当成同一回事。
 */
export default function Page() {
  const { t } = useTranslation();
  const net = useNetworkRate();

  return (
    <div className="space-y-8">
      <PageHeader title={`${t('system.title')} / ${t('system.network')}`} />

      <Card>
        <CardContent className="p-6">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Activity className="size-4" />
            <span>{t('net.realtime')}</span>
            <span className="ml-auto">{t('net.since_boot')}</span>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-8 sm:grid-cols-4">
            <BigRate
              label={`↓ ${t('net.down')}`}
              value={net ? formatRate(net.rxRate) : '—'}
              total={net ? formatBytes(net.rxTotal) : '—'}
            />
            <BigRate
              label={`↑ ${t('net.up')}`}
              value={net ? formatRate(net.txRate) : '—'}
              total={net ? formatBytes(net.txTotal) : '—'}
            />
          </div>

          <NetworkSparkline history={net?.history ?? []} className="mt-6" />
        </CardContent>
      </Card>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('net.iface')}</TableHead>
              <TableHead className="text-right">↓ {t('net.down')}</TableHead>
              <TableHead className="text-right">↑ {t('net.up')}</TableHead>
              <TableHead className="text-right">↓ {t('net.total')}</TableHead>
              <TableHead className="text-right">↑ {t('net.total')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {net?.ifaces.map((i) => (
              <TableRow key={i.name}>
                <TableCell className="font-medium">{i.name}</TableCell>
                <TableCell className="text-right tabular-nums">{formatRate(i.rx)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatRate(i.tx)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatBytes(i.rxTotal)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatBytes(i.txTotal)}
                </TableCell>
              </TableRow>
            ))}
            {(!net || net.ifaces.length === 0) && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  {t('app.loading')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
