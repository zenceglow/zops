import { useCallback, useEffect, useRef, useState } from 'react';
import {
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
  listRuns,
  readRunLog,
  runJob,
  saveScript,
  uploadFile,
  type DeployJob,
  type DeployRun,
} from './_api';

const SCRIPT_TEMPLATE = `# 在 /opt/docker-apps/<服务名>/ 里执行（工作目录就是这个目录，开头等于已经 set -e）
tar zxvf package.tgz -C ./
rm -rf ./bin
mv -f ./服务名/* ./
docker build -t 服务名 .
docker compose up -d --build
`;

function human(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}

function when(iso?: string | null): string {
  if (!iso) return '—';
  // SQLite 给的是 UTC 的 "YYYY-MM-DD HH:MM:SS"，补上 Z 再本地化。
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return d.toLocaleString();
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
    success: { label: '成功', className: 'text-emerald-600', icon: CheckCircle2 },
    failed: { label: '失败', className: 'text-destructive', icon: XCircle },
    running: { label: '部署中', className: 'text-amber-600', icon: Loader2 },
    draft: { label: '待部署', className: 'text-muted-foreground', icon: CircleDashed },
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
  const [jobs, setJobs] = useState<DeployJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    return list;
  }, []);

  useEffect(() => {
    refresh()
      .catch((e) => toast.error(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, [refresh]);

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
            chunk.exit_code === 0 ? '部署完成' : `部署失败（退出码 ${chunk.exit_code ?? '?'}）`,
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
      toast.success(`已创建 ${job.name}，目录 ${job.dir}`);
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
        toast.success(`已上传 ${file.name}`);
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
      toast.success('部署脚本已保存');
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
    if (!window.confirm(`删除部署任务「${selected.name}」？目录和产物会留在服务器上。`)) return;
    try {
      await deleteJob(selected.id);
      setSelectedId(null);
      await refresh();
      toast.success('已删除记录');
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">部署</h1>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">部署</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            一个部署任务 = <span className="font-mono">/opt/docker-apps/&lt;服务名&gt;/</span> 目录 +
            产物 + 部署脚本。三步走：传产物 → 写脚本 → 执行；每次执行都留记录。
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus />
          新建部署任务
        </Button>
      </div>

      {jobs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Rocket className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              还没有部署任务。新建一个，它会替你在服务器上建好专属目录。
            </p>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              新建部署任务
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          {/* 左：任务列表 */}
          <div className="space-y-2">
            {jobs.map((job) => (
              <button
                key={job.id}
                type="button"
                onClick={() => setSelectedId(job.id)}
                className={cn(
                  'w-full rounded-xl border border-border/60 p-3 text-left transition-colors hover:bg-muted/50',
                  job.id === selectedId && 'border-primary/50 bg-primary/5',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-sm">{job.name}</span>
                  {job.source === 'agent' && (
                    <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                      agent
                    </Badge>
                  )}
                </div>
                <div className="mt-1.5">
                  <StatusBadge status={job.status} />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {job.last_run_at ? when(job.last_run_at) : '还没部署过'}
                </p>
              </button>
            ))}
          </div>

          {/* 右：三步走 + 记录 */}
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
                    创建人 {selected.actor}
                    {selected.container_name && (
                      <>
                        {' · 容器 '}
                        <span className="font-mono">{selected.container_name}</span>
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
                    上传产物
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
                      拖文件进来，或点击选择（产物、compose、配置都行）
                    </span>
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => void onUpload(e.target.files)}
                    />
                  </label>
                  {uploadPct !== null && (
                    <p className="text-xs text-muted-foreground">上传中 {uploadPct}%</p>
                  )}
                  {selected.files.length > 0 && (
                    <ul className="divide-y divide-border/60 text-xs">
                      {selected.files.map((f) => (
                        <li key={f.path} className="flex items-center gap-2 py-1.5">
                          <span className="flex-1 truncate font-mono">{f.path}</span>
                          <span className="text-muted-foreground">{human(f.size)}</span>
                          <span className="hidden text-muted-foreground sm:inline">
                            {f.uploaded_by} · {when(f.uploaded_at)}
                          </span>
                          <button
                            type="button"
                            aria-label={`删除 ${f.path}`}
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
                      部署脚本
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setScript(SCRIPT_TEMPLATE)}
                      >
                        填入参考模板
                      </Button>
                      <Button size="sm" variant="outline" onClick={onSaveScript} disabled={savingScript}>
                        <Save />
                        保存
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
                      执行部署
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (window.confirm(`在 ${selected.dir} 里执行部署脚本？`)) void onRun();
                      }}
                      disabled={!!activeRun || !script.trim()}
                    >
                      {activeRun ? <Loader2 className="animate-spin" /> : <Play />}
                      {activeRun ? '部署中…' : '执行部署'}
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
                  <div className="text-sm font-medium">部署记录</div>
                  {runs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">还没有执行过。</p>
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
                            <span className="text-muted-foreground">{when(run.started_at)}</span>
                            {run.duration_ms != null && (
                              <span className="text-muted-foreground">
                                {(run.duration_ms / 1000).toFixed(1)}s
                              </span>
                            )}
                            {run.exit_code != null && run.exit_code !== 0 && (
                              <span className="text-destructive">exit {run.exit_code}</span>
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
        </div>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建部署任务</DialogTitle>
            <DialogDescription>
              会在服务器上创建 <span className="font-mono">/opt/docker-apps/&lt;服务名&gt;/</span>
              。服务名同时用作目录名、容器名和镜像名。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="deploy-name">服务名</Label>
              <Input
                id="deploy-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="zenceglow-web"
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deploy-note">备注（可选）</Label>
              <Input
                id="deploy-note"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="这次部署是干什么的"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button onClick={onCreate} disabled={busy || !newName.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
