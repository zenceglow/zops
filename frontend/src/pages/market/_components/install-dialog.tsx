import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { toast } from '../../../components/ui/sonner';
import { cn } from '../../../lib/utils';
import { fetchNetworks } from '../../docker/_api';
import { readRunLog } from '../../deploy/_api';
import {
  installApp,
  localized,
  planApp,
  type InstallOptions,
  type InstallPlan,
  type MarketApp,
} from '../_api';
import { AppIcon } from './app-icon';

/** 参数改了之后多久去重算一次方案。 */
const PLAN_DEBOUNCE_MS = 350;
/** 拉部署日志的间隔。 */
const LOG_POLL_MS = 1200;

type Phase = 'form' | 'running' | 'done' | 'failed';

/**
 * 一键部署的交互弹窗。
 *
 * 三件事必须同时成立，少了哪一条这个弹窗就是不合格的：
 *
 * 1. **参数能改，默认能跑。** 端口、网络、密码都预填成"一路点下去就能装出一个能连的
 *    库"。默认值是清单给的，不是前端猜的。
 * 2. **动手之前能看见要写什么。** 预览页签给的就是**服务端渲染出来的那份 compose**
 *    —— 不是前端照着参数拼的第二份。两份一定会不一致，而不一致的那天没人知道。
 *    密码在那里是 `******`（服务端遮的），因为这份东西是要给人看、会被复制的。
 * 3. **装的过程看得见。** 部署是真异步的（拉镜像可能要几分钟），所以弹窗切到日志态
 *    一直拉，而不是转个圈假装在忙。
 */
export function InstallDialog({
  app,
  open,
  onOpenChange,
  onInstalled,
}: {
  app: MarketApp | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');

  const [tab, setTab] = useState('params');
  const [phase, setPhase] = useState<Phase>('form');
  const [name, setName] = useState('');
  const [network, setNetwork] = useState('local');
  const [networks, setNetworks] = useState<string[]>([]);
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);

  const logRef = useRef<HTMLPreElement>(null);

  /** 打开时把参数重置成清单给的默认值 —— 上次装别的应用填的东西不该留下来。 */
  useEffect(() => {
    if (!open || !app) return;
    setTab('params');
    setPhase('form');
    setName(app.default_name);
    setNetwork('local');
    setPorts(Object.fromEntries(app.ports.map((p) => [p.key, String(p.host_default)])));
    setEnvVars(Object.fromEntries(app.env.map((e) => [e.key, e.default])));
    setPlan(null);
    setPlanError(null);
    setRunId(null);
    setLog('');
    setExitCode(null);
  }, [open, app]);

  /** 可选网络 = 机器上已有的 + local + 当前选中的（列不出来时也得能显示）。 */
  useEffect(() => {
    if (!open) return;
    void fetchNetworks()
      .then((d) => setNetworks(d.networks.map((n) => n.name)))
      .catch(() => setNetworks([]));
  }, [open]);

  const options = useMemo<InstallOptions>(() => {
    const p: Record<string, number> = {};
    for (const [k, v] of Object.entries(ports)) {
      const n = Number(v);
      p[k] = Number.isFinite(n) ? n : 0;
    }
    return { app: app?.id ?? '', name, network, ports: p, env: envVars };
  }, [app, name, network, ports, envVars]);

  /**
   * 边填边算方案。
   *
   * 校验和渲染都在服务端（`/app/plan`），前端只负责把结果显示出来 —— 于是"预览说
   * 没问题、一点部署才报错"这种分叉从结构上就不可能出现：两边是同一份代码。
   */
  useEffect(() => {
    if (!open || !app || phase !== 'form') return;
    const id = setTimeout(() => {
      void planApp(options)
        .then((p) => {
          setPlan(p);
          setPlanError(null);
        })
        .catch((e: unknown) => {
          setPlan(null);
          setPlanError(e instanceof Error ? e.message : t('market.err.plan'));
        });
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [open, app, options, phase, t]);

  /** 增量拉日志，直到跑完。读日志失败不判死 —— 下一轮接着读。 */
  useEffect(() => {
    if (phase !== 'running' || !runId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offset = 0;

    const tick = async () => {
      if (stopped) return;
      try {
        const r = await readRunLog(runId, offset);
        offset = r.offset;
        if (r.output) setLog((prev) => prev + r.output);
        if (r.finished) {
          setExitCode(r.exit_code ?? null);
          setPhase(r.exit_code === 0 ? 'done' : 'failed');
          onInstalled?.();
          return;
        }
      } catch {
        /* 忽略，下一轮再试 */
      }
      if (!stopped) timer = setTimeout(tick, LOG_POLL_MS);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, runId, onInstalled]);

  /** 日志自动跟到底部。 */
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      const out = await installApp(options);
      setRunId(out.run.id);
      setLog('');
      setExitCode(null);
      setPhase('running');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('market.err.install'));
    } finally {
      setSubmitting(false);
    }
  }, [options, t]);

  if (!app) return null;

  const networkOptions = Array.from(new Set([network, 'local', ...networks])).filter(Boolean);
  const busy = phase === 'running' || submitting;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="max-h-[90vh] gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <AppIcon appId={app.id} className="size-10" />
            <span className="flex items-baseline gap-2">
              {app.name}
              <span className="text-xs font-normal text-muted-foreground">{app.version}</span>
            </span>
          </DialogTitle>
          <DialogDescription>{localized(app.tagline, app.tagline_en)}</DialogDescription>
        </DialogHeader>

        {phase === 'form' ? (
          <Tabs value={tab} onValueChange={setTab} className="min-h-0">
            <TabsList>
              <TabsTrigger value="params">{t('market.dialog.tab_params')}</TabsTrigger>
              <TabsTrigger value="preview">{t('market.dialog.tab_preview')}</TabsTrigger>
            </TabsList>

            <TabsContent value="params" className="mt-3 min-h-0">
              <div className="max-h-[46vh] space-y-5 overflow-y-auto pr-1">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('market.dialog.name')} hint={t('market.dialog.name_hint')}>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={app.default_name}
                      className="font-mono"
                    />
                  </Field>
                  <Field label={t('market.dialog.network')} hint={t('market.dialog.network_hint')}>
                    <Select value={network} onValueChange={setNetwork}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {networkOptions.map((n) => (
                          <SelectItem key={n} value={n}>
                            {n}
                            {n === 'local' ? ` · ${t('market.dialog.network_default')}` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                <Section title={t('market.dialog.ports_title')}>
                  {app.ports.map((p) => (
                    <div key={p.key} className="flex items-start gap-3 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm">{localized(p.label, p.label_en)}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {localized(p.hint, p.hint_en)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Input
                          value={ports[p.key] ?? ''}
                          inputMode="numeric"
                          onChange={(e) =>
                            setPorts((prev) => ({
                              ...prev,
                              [p.key]: e.target.value.replace(/[^0-9]/g, ''),
                            }))
                          }
                          className="w-24 font-mono"
                        />
                        {/* 容器侧端口是镜像的契约，改不了 —— 明写出来省得有人问。 */}
                        <span className="text-xs text-muted-foreground">
                          → {t('market.dialog.container_port')} {p.container}
                        </span>
                      </div>
                    </div>
                  ))}
                </Section>

                <Section title={t('market.dialog.env_title')}>
                  {app.env.map((e) => (
                    <div key={e.key} className="py-1.5">
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`env-${e.key}`} className="text-sm">
                          {localized(e.label, e.label_en)}
                        </Label>
                        {e.required && (
                          <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-600 dark:text-rose-400">
                            {t('market.dialog.required')}
                          </span>
                        )}
                        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                          {e.key}
                        </span>
                      </div>
                      <Input
                        id={`env-${e.key}`}
                        type={e.secret ? 'password' : 'text'}
                        value={envVars[e.key] ?? ''}
                        placeholder={e.default || (e.required ? t('market.dialog.required_ph') : '')}
                        onChange={(ev) =>
                          setEnvVars((prev) => ({ ...prev, [e.key]: ev.target.value }))
                        }
                        className="mt-1.5"
                      />
                      <div className="mt-1 text-xs text-muted-foreground">
                        {localized(e.hint, e.hint_en)}
                        {e.min_len > 0 ? ` · ${t('market.dialog.min_len', { n: e.min_len })}` : ''}
                      </div>
                    </div>
                  ))}
                </Section>

                {planError && (
                  <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
                    {planError}
                  </div>
                )}

                {plan && plan.warnings.length > 0 && (
                  <div className="space-y-1.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                    {plan.warnings.map((w) => (
                      <div
                        key={w}
                        className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400"
                      >
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-1.5 text-xs text-muted-foreground">
                  {app.notes.map((n, i) => (
                    <div key={n} className="flex gap-2">
                      <span className="text-muted-foreground/50">•</span>
                      <span>{localized(n, app.notes_en[i] ?? n)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="preview" className="mt-3 min-h-0">
              <div className="max-h-[52vh] space-y-3 overflow-y-auto pr-1">
                <div className="text-xs text-muted-foreground">
                  {t('market.dialog.preview_hint')}
                </div>
                <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                  {plan?.compose ?? t('market.dialog.preview_loading')}
                </pre>
                <div className="pt-1 text-xs font-medium text-muted-foreground">
                  {t('market.dialog.script')}
                </div>
                <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                  {plan?.script ?? ''}
                </pre>
                {plan && (
                  <div className="pb-1 text-xs text-muted-foreground">
                    {t('market.dialog.dir')}
                    <span className="ml-1 font-mono">{plan.dir}</span>
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        ) : (
          // 部署开始之后就把表单收起来：这时候改参数已经没有意义了，留着只会让人
          // 以为还能改。
          <div className="min-h-0 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              {phase === 'running' && (
                <>
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  <span>{t('market.dialog.installing')}</span>
                </>
              )}
              {phase === 'done' && (
                <>
                  <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-emerald-700 dark:text-emerald-400">
                    {t('market.dialog.done')}
                  </span>
                </>
              )}
              {phase === 'failed' && (
                <>
                  <XCircle className="size-4 text-rose-600 dark:text-rose-400" />
                  <span className="text-rose-700 dark:text-rose-400">
                    {t('market.dialog.failed', { code: exitCode ?? -1 })}
                  </span>
                </>
              )}
            </div>

            <pre
              ref={logRef}
              className="max-h-[44vh] min-h-[180px] overflow-auto rounded-xl border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed"
            >
              {log || t('market.dialog.waiting')}
            </pre>

            {phase === 'done' && (
              <div className="space-y-1.5 text-xs text-muted-foreground">
                {app.notes.map((n, i) => (
                  <div key={n} className="flex gap-2">
                    <span className="text-muted-foreground/50">•</span>
                    <span>{localized(n, app.notes_en[i] ?? n)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {phase === 'form' ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('market.dialog.cancel')}
              </Button>
              <Button onClick={() => void submit()} disabled={submitting || !!planError}>
                {submitting && <Loader2 className="animate-spin" />}
                {t('market.dialog.submit')}
              </Button>
            </>
          ) : (
            <>
              {phase === 'failed' && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setPhase('form');
                    setLog('');
                  }}
                >
                  {t('market.dialog.back')}
                </Button>
              )}
              <Button onClick={() => onOpenChange(false)}>{t('market.dialog.close')}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="text-sm">{label}</Label>
      <div className="mt-1.5">{children}</div>
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-xl border border-border/60 px-3 py-2')}>
      <div className="pb-1 pt-1.5 text-xs font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}
