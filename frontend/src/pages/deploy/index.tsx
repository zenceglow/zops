import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Play,
  Plus,
  Rocket,
  Save,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { toast } from '../../components/ui/sonner';
import { cn } from '../../lib/utils';
import {
  createJob,
  deleteFile,
  deleteJob,
  listJobs,
  listServices,
  listRuns,
  readRunLog,
  runJob,
  saveScript,
  uploadFile,
  type DeployJob,
  type DeployRun,
  type ServiceContainer,
} from './_api';

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/** 部署脚本的参考模板。第一行注释跟着界面语言走，其余是 shell。 */
function scriptTemplate(t: TFunc): string {
  return `${t('deploy.template_head')}
tar zxvf package.tgz -C ./
rm -rf ./bin
mv -f ./<name>/* ./
docker build -t <name> .
docker compose up -d --build`;
}

function human(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}

function when(iso: string | null | undefined, t: TFunc): string {
  if (!iso) return '—';
  // SQLite 给的是 UTC 的 "YYYY-MM-DD HH:MM:SS"，补上 Z 再本地化。
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return t('deploy.just_now');
  if (diff < 3600) return t('deploy.minutes_ago', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('deploy.hours_ago', { n: Math.floor(diff / 3600) });
  return d.toLocaleString();
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const map: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
    success: { label: t('deploy.status_success'), className: 'text-emerald-600', icon: CheckCircle2 },
    failed: { label: t('deploy.status_failed'), className: 'text-destructive', icon: XCircle },
    running: { label: t('deploy.status_running'), className: 'text-amber-600', icon: Loader2 },
    draft: { label: t('deploy.status_draft'), className: 'text-muted-foreground', icon: CircleDashed },
  };
  const it = map[status] ?? map.draft;
  const Icon = it.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', it.className)}>
      <Icon className={cn('size-3.5', status === 'running' && 'animate-spin')} />
      {it.label}
    </span>
  );
}

export default function DeployPage() {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<DeployJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 机器上真实在跑的服务。「应用与服务」是建立在 Docker 之上的那一层：
   *  没建过部署任务的服务也要列出来，否则"首页看得到、进来就没了"。 */
  const [services, setServices] = useState<ServiceContainer[]>([]);
  /** 点了没有部署任务的服务 —— 右侧显示"纳管"面板，而不是一片空白。 */
  const [adoptTarget, setAdoptTarget] = useState<{ name: string } | null>(null);
  /** 服务可能很多，靠眼里在窄栏里找是不行的。 */
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'running' | 'stopped' | 'unmanaged'>('all');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newNote, setNewNote] = useState('');
  const [busy, setBusy] = useState(false);

  const [script, setScript] = useState('');
  const [savingScript, setSavingScript] = useState(false);

  const [runs, setRuns] = useState<DeployRun[]>([]);
  const [activeRun, setActiveRun] = useState<DeployRun | null>(null);
  const [log, setLog] = useState('');
  const [uploadPct, setUploadPct] = useState<number | null>(null);

  const offsetRef = useRef(0);
  const logEndRef = useRef<HTMLPreElement>(null);

  const selected = jobs.find((j) => j.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    const list = await listJobs();
    setJobs(list);
    return list;
  }, []);

  useEffect(() => {
    refresh()
      .catch((e) => toast.error(String(e.message ?? e)))
      .finally(() => setLoading(false));
    void listServices()
      .then(setServices)
      .catch(() => setServices([]));
  }, [refresh]);

  /** 服务 + 部署任务合并成一张表：同名就是同一个应用。 */
  const apps = useMemo(() => {
    const rows = new Map<string, { name: string; job?: DeployJob; service?: ServiceContainer }>();
    for (const c of services) rows.set(c.name, { name: c.name, service: c });
    for (const j of jobs) {
      const row = rows.get(j.name);
      if (row) row.job = j;
      else rows.set(j.name, { name: j.name, job: j });
    }
    // 在跑的排前面，其余按名字。
    return [...rows.values()].sort((a, b) => {
      const ar = a.service?.state === 'running';
      const br = b.service?.state === 'running';
      if (ar !== br) return ar ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [services, jobs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return apps.filter((a) => {
      if (q && !a.name.toLowerCase().includes(q) && !(a.service?.image ?? '').toLowerCase().includes(q)) {
        return false;
      }
      switch (filter) {
        case 'running':
          return a.service?.state === 'running';
        case 'stopped':
          return a.service !== undefined && a.service.state !== 'running';
        case 'unmanaged':
          return !a.job;
        default:
          return true;
      }
    });
  }, [apps, query, filter]);

  useEffect(() => {
    if (!selected) return;
    setScript(selected.script);
    void listRuns(selected.id)
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [selected?.id]);

  // 部署中：按 offset 接着拉日志，画到下面的黑框里。跑完就刷新列表和记录。
  useEffect(() => {
    if (!activeRun) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const chunk = await readRunLog(activeRun.id, offsetRef.current);
        if (stopped) return;
        offsetRef.current = chunk.offset;
        if (chunk.output) {
          setLog((prev) => prev + chunk.output);
          logEndRef.current?.scrollIntoView({ block: 'end' });
        }
        if (chunk.finished) {
          clearInterval(timer);
          setActiveRun(null);
          await refresh();
          if (selected) setRuns(await listRuns(selected.id));
          toast[chunk.exit_code === 0 ? 'success' : 'error'](
            chunk.exit_code === 0
              ? t('deploy.done')
              : t('deploy.run_failed', { code: chunk.exit_code ?? '?' }),
          );
        }
      } catch {
        /* 下一轮再试 */
      }
    }, 1200);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [activeRun?.id]);

  const onCreate = async () => {
    setBusy(true);
    try {
      const job = await createJob(newName.trim(), newNote.trim());
      setCreating(false);
      setNewName('');
      setNewNote('');
      await refresh();
      setSelectedId(job.id);
      toast.success(t('deploy.created', { name: job.name, dir: job.dir }));
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 纳管一个已经在跑的服务：给它建一条部署任务（同名），之后就能传产物、写脚本、
   * 留记录。这是"应用与服务"和纯 Docker 的区别 —— 不纳管也能看，纳管了才有记录。
   */
  const onAdopt = async (name: string) => {
    setBusy(true);
    try {
      const job = await createJob(name, t('deploy.unmanaged'));
      setAdoptTarget(null);
      await refresh();
      setSelectedId(job.id);
      toast.success(t('deploy.adopted', { name }));
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (files: FileList | null) => {
    if (!selected || !files?.length) return;
    for (const file of Array.from(files)) {
      try {
        setUploadPct(0);
        await uploadFile(selected.id, file.name, file, (loaded, total) =>
          setUploadPct(Math.round((loaded / total) * 100)),
        );
        toast.success(t('deploy.uploaded', { name: file.name }));
      } catch (e) {
        toast.error(`${file.name}：${(e as Error).message}`);
      } finally {
        setUploadPct(null);
      }
    }
    await refresh();
  };

  const onSaveScript = async () => {
    if (!selected) return;
    setSavingScript(true);
    try {
      await saveScript(selected.id, script);
      await refresh();
      toast.success(t('deploy.saved'));
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setSavingScript(false);
    }
  };

  const onRun = async () => {
    if (!selected) return;
    try {
      setLog('');
      offsetRef.current = 0;
      const run = await runJob(selected.id);
      setActiveRun(run);
      await refresh();
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const onDeleteJob = async () => {
    if (!selected) return;
    if (!window.confirm(t('deploy.confirm_delete', { name: selected.name }))) return;
    try {
      await deleteJob(selected.id);
      setSelectedId(null);
      await refresh();
      toast.success(t('deploy.deleted'));
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">{t('deploy.title')}</h1>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('deploy.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('deploy.subtitle')}</p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus />
          {t('deploy.new')}
        </Button>
      </div>

      {apps.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Rocket className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('deploy.empty')}</p>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              {t('deploy.new')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 工具条：服务一多，靠肉眼在窄栏里找是不行的 */}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('deploy.search')}
              className="h-8 w-52 text-xs"
            />
            {(
              [
                { id: 'all', label: t('deploy.filter_all') },
                { id: 'running', label: t('deploy.state_running') },
                { id: 'stopped', label: t('deploy.state_stopped') },
                { id: 'unmanaged', label: t('deploy.filter_unmanaged') },
              ] as { id: typeof filter; label: string }[]
            ).map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={filter === f.id ? 'default' : 'outline'}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </Button>
            ))}
            <span className="ml-auto text-xs text-muted-foreground">
              {t('deploy.count', {
                total: apps.length,
                managed: apps.filter((a) => a.job).length,
              })}
            </span>
          </div>

          {/* 列表：一行一个服务，行高固定 —— 三十个服务也就是三十行，不是一条滚不到头的窄栏。 */}
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-border/60">
                {filtered.map((app) => {
                  const job = app.job;
                  const running = app.service?.state === 'running';
                  return (
                    <li key={app.name}>
                      <button
                        type="button"
                        onClick={() => {
                          if (job) {
                            setAdoptTarget(null);
                            setSelectedId(job.id);
                          } else {
                            setSelectedId(null);
                            setAdoptTarget({ name: app.name });
                          }
                        }}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                      >
                        <span
                          className={cn(
                            'size-2 shrink-0 rounded-full',
                            running ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                          )}
                          title={running ? t('deploy.state_running') : t('deploy.state_stopped')}
                        />
                        <span className="w-44 shrink-0 truncate font-mono text-sm">
                          {app.name}
                        </span>
                        <span className="hidden min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground sm:block">
                          {app.service?.image ?? t('deploy.no_service')}
                        </span>
                        <span className="hidden w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground md:block">
                          {app.service?.ports ?? ''}
                        </span>
                        <span className="shrink-0">
                          {job ? (
                            <StatusBadge status={job.status} />
                          ) : (
                            <span className="text-[11px] text-muted-foreground">
                              {t('deploy.unmanaged')}
                            </span>
                          )}
                        </span>
                        <span className="hidden w-28 shrink-0 text-right text-[11px] text-muted-foreground sm:block">
                          {job?.last_run_at ? when(job.last_run_at, t) : ''}
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  );
                })}
                {filtered.length === 0 && (
                  <li className="px-4 py-10 text-center text-xs text-muted-foreground">
                    {t('deploy.no_match')}
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>

          {/* 详情按需展开：列表占满宽度，三步走只在点开某个服务时出现。 */}
          <Dialog
            open={!!selected || !!adoptTarget}
            onOpenChange={(v) => {
              if (!v) {
                setSelectedId(null);
                setAdoptTarget(null);
              }
            }}
          >
            <DialogContent className="sm:max-w-3xl">
          {adoptTarget && !selected && (
            <Card>
              <CardContent className="space-y-3 py-10 text-center">
                <Rocket className="mx-auto size-6 text-muted-foreground" />
                <p className="font-mono text-sm">{adoptTarget.name}</p>
                <p className="mx-auto max-w-md text-xs text-muted-foreground">
                  {t('deploy.adopt_desc')}
                </p>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void onAdopt(adoptTarget.name)}
                >
                  <Plus />
                  {t('deploy.adopt')}
                </Button>
              </CardContent>
            </Card>
          )}

          {selected && (
            <div className="space-y-4">
              <Card>
                <CardContent className="space-y-1 pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-sm">{selected.dir}</span>
                    <Button size="sm" variant="ghost" onClick={onDeleteJob}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  {selected.note && (
                    <p className="text-xs text-muted-foreground">{selected.note}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t('deploy.created_by', { who: selected.actor })}
                    {selected.container_name && (
                      <>
                        {' · '}
                        {t('deploy.container', { name: selected.container_name })}
                      </>
                    )}
                  </p>
                </CardContent>
              </Card>

              {/* ① 产物 */}
              <Card>
                <CardContent className="space-y-3 pt-5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-[11px]">
                      1
                    </span>
                    {t('deploy.step1')}
                  </div>
                  <label
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      void onUpload(e.dataTransfer.files);
                    }}
                    className="flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-border/70 py-6 text-center transition-colors hover:bg-muted/40"
                  >
                    <Upload className="size-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                      {t('deploy.step1_hint')}
                    </span>
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => void onUpload(e.target.files)}
                    />
                  </label>
                  {uploadPct !== null && (
                    <p className="text-xs text-muted-foreground">
                      {t('deploy.uploading', { pct: uploadPct })}
                    </p>
                  )}
                  {selected.files.length > 0 && (
                    <ul className="divide-y divide-border/60 text-xs">
                      {selected.files.map((f) => (
                        <li key={f.path} className="flex items-center gap-2 py-1.5">
                          <span className="flex-1 truncate font-mono">{f.path}</span>
                          <span className="text-muted-foreground">{human(f.size)}</span>
                          <span className="hidden text-muted-foreground sm:inline">
                            {f.uploaded_by} · {when(f.uploaded_at, t)}
                          </span>
                          <button
                            type="button"
                            aria-label={t('deploy.delete_file', { path: f.path })}
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() =>
                              void deleteFile(selected.id, f.path).then(refresh)
                            }
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              {/* ② 脚本 */}
              <Card>
                <CardContent className="space-y-3 pt-5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-[11px]">
                        2
                      </span>
                      {t('deploy.step2')}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setScript(scriptTemplate(t))}
                      >
                        {t('deploy.fill_template')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={onSaveScript} disabled={savingScript}>
                        <Save />
                        {t('deploy.save')}
                      </Button>
                    </div>
                  </div>
                  <textarea
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    spellCheck={false}
                    rows={9}
                    placeholder="docker compose up -d --build"
                    className="w-full rounded-lg border border-input bg-transparent p-3 font-mono text-xs outline-none focus-visible:border-ring"
                  />
                </CardContent>
              </Card>

              {/* ③ 执行 */}
              <Card>
                <CardContent className="space-y-3 pt-5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-[11px]">
                        3
                      </span>
                      {t('deploy.step3')}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (window.confirm(t('deploy.confirm_run', { dir: selected.dir })))
                          void onRun();
                      }}
                      disabled={!!activeRun || !script.trim()}
                    >
                      {activeRun ? <Loader2 className="animate-spin" /> : <Play />}
                      {activeRun ? t('deploy.running') : t('deploy.run')}
                    </Button>
                  </div>
                  {log && (
                    <pre
                      ref={logEndRef}
                      className="max-h-72 overflow-auto rounded-lg bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-200"
                    >
                      {log}
                    </pre>
                  )}
                </CardContent>
              </Card>

              {/* 记录 */}
              <Card>
                <CardContent className="space-y-2 pt-5">
                  <div className="text-sm font-medium">{t('deploy.records')}</div>
                  {runs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('deploy.no_records')}</p>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {runs.map((run) => (
                        <li key={run.id} className="py-2">
                          <div className="flex items-center gap-3 text-xs">
                            <StatusBadge status={run.status} />
                            <span className="text-muted-foreground">
                              {run.actor}
                              {run.actor_kind === 'agent' ? '（agent）' : ''}
                            </span>
                            <span className="text-muted-foreground">
                              {when(run.started_at, t)}
                            </span>
                            {run.duration_ms != null && (
                              <span className="text-muted-foreground">
                                {(run.duration_ms / 1000).toFixed(1)}s
                              </span>
                            )}
                            {run.exit_code != null && run.exit_code !== 0 && (
                              <span className="text-destructive">
                                {t('deploy.exit_code', { code: run.exit_code })}
                              </span>
                            )}
                          </div>
                          {run.output && (
                            <pre className="mt-1.5 max-h-32 overflow-auto rounded bg-muted/50 p-2 font-mono text-[10px]">
                              {run.output}
                            </pre>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
            </DialogContent>
          </Dialog>
        </>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deploy.new')}</DialogTitle>
            <DialogDescription>{t('deploy.dir_hint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="deploy-name">{t('deploy.name')}</Label>
              <Input
                id="deploy-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="zenceglow-web"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deploy-note">{t('deploy.note')}</Label>
              <Input
                id="deploy-note"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder={t('deploy.note_placeholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              {t('deploy.cancel')}
            </Button>
            <Button onClick={onCreate} disabled={busy || !newName.trim()}>
              {t('deploy.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
