import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Check, Clock, LogOut, ShieldCheck, User, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { cn } from '../../lib/utils';
import useAuthorizeStore from '../../stores/authorize.store';
import useUserStore from '../../stores/user.store';
import { fetchMe, fetchMyAudit, type AuditRow, type Me } from './_api';

/** 权限是一个个 id（`ops.service.control`），太长不看 —— 只列"能进哪些栏目"这种能读的。 */
function readablePermissions(ids: string[]) {
  return ids.filter((p) => p.startsWith('nav.')).map((p) => p.slice(4));
}

/**
 * 个人中心。
 *
 * 两块：我是谁（账号、角色、加入时间、能进哪些栏目），以及我干过什么 —— 后者直接
 * 读审计日志里属于本人的记录。看自己的操作记录不需要额外的审计权限，这是"我的
 * 数据"而不是"全站数据"。
 */
export default function ProfilePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useUserStore((s) => s.user);
  const [me, setMe] = useState<Me | null>(null);
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchMe().catch(() => null), fetchMyAudit(100).catch(() => [])])
      .then(([m, l]) => {
        setMe(m);
        setLogs(l);
      })
      .finally(() => setLoading(false));
  }, []);

  const logout = () => {
    useAuthorizeStore.getState().logout();
    useUserStore.getState().clear();
    navigate('/login', { replace: true });
  };

  const role = me?.role === 'super_admin' ? t('members.role_super') : t('members.role_member');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{t('profile.title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <User className="size-4" />
            {t('profile.account')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading ? (
            <Skeleton className="h-20 w-full rounded-xl" />
          ) : (
            <>
              <div className="flex items-center gap-4">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-foreground text-xl font-semibold text-background">
                  {(me?.username ?? user?.username ?? '?').slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-lg font-medium">
                    {me?.username ?? user?.username ?? '—'}
                  </p>
                  <p className="mt-0.5 flex items-center gap-2 text-sm text-muted-foreground">
                    <ShieldCheck className="size-3.5" />
                    {role}
                  </p>
                </div>
                <Button variant="outline" className="ml-auto" onClick={logout}>
                  <LogOut />
                  {t('nav.logout')}
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-border/60 px-3.5 py-2.5">
                  <p className="text-xs text-muted-foreground">{t('profile.joined')}</p>
                  <p className="mt-0.5 font-mono text-sm">{me?.created_at || '—'}</p>
                </div>
                <div className="rounded-xl border border-border/60 px-3.5 py-2.5">
                  <p className="text-xs text-muted-foreground">{t('profile.permission_count')}</p>
                  <p className="mt-0.5 font-mono text-sm tabular-nums">{me?.permissions.length ?? 0}</p>
                </div>
              </div>

              {me && readablePermissions(me.permissions).length > 0 && (
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">{t('profile.sections')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {readablePermissions(me.permissions).map((p) => (
                      <Badge key={p} variant="secondary">
                        {t(`nav.${p === 'logs' ? 'logs' : p}`, { defaultValue: p })}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" />
            {t('profile.my_actions')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-1 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full rounded-lg" />
              ))}
            </div>
          ) : logs.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">{t('profile.no_actions')}</p>
          ) : (
            <div className="divide-y divide-border/60">
              {logs.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-md',
                      l.status < 400 ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/15 text-red-600 dark:text-red-400',
                    )}
                  >
                    {l.status < 400 ? <Check className="size-3" /> : <X className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{l.summary}</span>
                  <span className="hidden max-w-[280px] truncate font-mono text-xs text-muted-foreground md:block">
                    {l.detail}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{l.ip}</span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {l.at}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
