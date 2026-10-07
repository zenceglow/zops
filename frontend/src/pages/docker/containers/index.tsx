import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Container, Loader2, Play, RotateCw, Server, Square, Trash2 } from 'lucide-react';
import { PageHeader } from './_components/page-header';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent } from '../../../components/ui/card';
import { Skeleton } from '../../../components/ui/skeleton';
import { toast } from '../../../components/ui/sonner';
import { ConfirmDialog } from '../_components/confirm-dialog';
import { containerAction } from '../_api';
import type { ContainerInfo } from '../../../pages/monitor/_api/types';
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
  const { containers, docker, loading, reload } = useContainers();
  const [pending, setPending] = useState<ContainerInfo | null>(null);
  /** 正在执行启停重启的那一行。启停不是瞬时的，不给反馈用户会连点。 */
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (id: string, action: 'start' | 'stop' | 'restart') => {
    if (busyId) return;
    setBusyId(id);
    try {
      await containerAction(id, action);
      // 状态变化不是瞬时的，等一拍再读，看到的才是新状态。
      setTimeout(reload, 800);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const iconBtn =
    'rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

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
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {containers.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    <Link
                      to={`/docker/containers/${c.id}`}
                      className="transition-colors hover:text-foreground/70"
                    >
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {c.image}
                  </TableCell>
                  <TableCell>
                    <Badge variant={c.state === 'running' ? 'default' : 'secondary'}>
                      {c.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.ports || '-'}</TableCell>
                  {/* 行内操作：启停重启是日常，删除会确认。 */}
                  <TableCell>
                    <div className="flex items-center justify-end gap-0.5">
                      {busyId === c.id ? (
                        <span
                          className="flex items-center gap-1.5 pr-1 text-xs text-muted-foreground"
                          role="status"
                        >
                          <Loader2 className="size-3.5 animate-spin" />
                          {t('common.processing')}
                        </span>
                      ) : (
                        <>
                          {c.state === 'running' ? (
                            <>
                              <button
                                type="button"
                                title={t('sites.stop')}
                                aria-label={t('sites.stop')}
                                className={iconBtn}
                                disabled={busyId !== null}
                                onClick={() => void act(c.id, 'stop')}
                              >
                                <Square className="size-3.5" />
                              </button>
                              <button
                                type="button"
                                title={t('docker.restart')}
                                aria-label={t('docker.restart')}
                                className={iconBtn}
                                disabled={busyId !== null}
                                onClick={() => void act(c.id, 'restart')}
                              >
                                <RotateCw className="size-3.5" />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              title={t('sites.start')}
                              aria-label={t('sites.start')}
                              className={iconBtn}
                              disabled={busyId !== null}
                              onClick={() => void act(c.id, 'start')}
                            >
                              <Play className="size-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            title={t('docker.delete_container')}
                            aria-label={t('docker.delete_container')}
                            className={iconBtn}
                            disabled={busyId !== null}
                            onClick={() => setPending(c)}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={t('docker.confirm_container_title')}
        description={t('docker.confirm_container_desc', { name: pending?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          if (!pending) return;
          await containerAction(pending.id, 'remove');
          toast.success(t('docker.removed', { name: pending.name }));
          reload();
        }}
      />
    </div>
  );
}
