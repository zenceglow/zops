import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutomationTasks, useTaskExecutions } from './_hooks/use-automation';
import type { AutomationTask } from './_api';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';

const CRON_PRESETS = [
  { label: '每分钟', expr: '* * * * *' },
  { label: '每小时', expr: '0 * * * *' },
  { label: '每 6 小时', expr: '0 */6 * * *' },
  { label: '每天 2:00', expr: '0 2 * * *' },
  { label: '每天 6:00', expr: '0 6 * * *' },
  { label: '每周一 3:00', expr: '0 3 * * 1' },
  { label: '每月 1 日 0:00', expr: '0 0 1 * *' },
];

function formatTime(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts + 'Z').toLocaleString();
}

function statusBadge(status: string): string {
  switch (status) {
    case 'running': return 'bg-yellow-500/20 text-yellow-400';
    case 'success': return 'bg-green-500/20 text-green-400';
    case 'failed': return 'bg-red-500/20 text-red-400';
    default: return 'bg-muted text-muted-foreground';
  }
}

export default function AutomationTasksPage() {
  const { t } = useTranslation();
  const { tasks, loading, handleCreate, handleUpdate, handleDelete, handleRun } =
    useAutomationTasks();

  const [showForm, setShowForm] = useState(false);
  const [editTask, setEditTask] = useState<AutomationTask | null>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [cronExpr, setCronExpr] = useState('');

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const { executions, loading: execsLoading } = useTaskExecutions(selectedTaskId);

  const openCreate = useCallback(() => {
    setEditTask(null);
    setName('');
    setCommand('');
    setCronExpr('');
    setShowForm(true);
  }, []);

  const openEdit = useCallback((task: AutomationTask) => {
    setEditTask(task);
    setName(task.name);
    setCommand(task.command);
    setCronExpr(task.cron_expr);
    setShowForm(true);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || !command.trim() || !cronExpr.trim()) return;
    if (editTask) {
      await handleUpdate(editTask.id, { name: name.trim(), command: command.trim(), cron_expr: cronExpr.trim() });
    } else {
      await handleCreate({ name: name.trim(), command: command.trim(), cron_expr: cronExpr.trim() });
    }
    setShowForm(false);
  }, [name, command, cronExpr, editTask, handleUpdate, handleCreate]);

  const handleToggle = useCallback(
    (task: AutomationTask) => {
      handleUpdate(task.id, { enabled: !task.enabled });
    },
    [handleUpdate],
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{t('automation.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('automation.subtitle')}</p>
        </div>
        <Button size="sm" onClick={openCreate}>
          + {t('automation.add_task')}
        </Button>
      </div>

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Task list */}
        <div className="flex w-72 shrink-0 flex-col gap-2 overflow-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground p-4">{t('app.loading')}</p>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">{t('automation.no_tasks')}</p>
          ) : (
            tasks.map((task) => (
              <Card
                key={task.id}
                className={`cursor-pointer transition-colors ${
                  selectedTaskId === task.id
                    ? 'border-primary/50 bg-primary/5'
                    : 'hover:border-border/80'
                }`}
                onClick={() => setSelectedTaskId(task.id)}
              >
                <CardHeader className="p-3 pb-1">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{task.name}</CardTitle>
                    <label className="flex items-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="size-3.5 rounded accent-primary"
                        checked={task.enabled}
                        onChange={() => handleToggle(task)}
                      />
                    </label>
                  </div>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <p className="text-[11px] text-muted-foreground truncate" title={task.command}>
                    {task.command}
                  </p>
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    {task.cron_expr}
                  </p>
                  <div className="mt-2 flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-5 text-[10px] px-1.5"
                      onClick={(e) => { e.stopPropagation(); handleRun(task.id); }}
                    >
                      {t('automation.run_now')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 text-[10px] px-1.5"
                      onClick={(e) => { e.stopPropagation(); openEdit(task); }}
                    >
                      {t('automation.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 text-[10px] px-1.5 text-destructive hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); handleDelete(task.id); }}
                    >
                      {t('automation.delete')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Execution log panel */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {selectedTaskId ? (
            <div className="flex flex-col h-full gap-2">
              <h3 className="text-sm font-medium">{t('automation.log')}</h3>
              <div className="flex-1 overflow-auto rounded-lg border bg-black/50 p-3 font-mono text-xs leading-relaxed">
                {execsLoading ? (
                  <p className="text-muted-foreground">{t('app.loading')}</p>
                ) : executions.length === 0 ? (
                  <p className="text-muted-foreground">{t('automation.no_tasks')}</p>
                ) : (
                  executions.map((exec) => (
                    <div key={exec.id} className="mb-3 border-b border-white/10 pb-2">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] text-muted-foreground">
                          {formatTime(exec.started_at)}
                        </span>
                        <span className={`rounded px-1 text-[10px] ${statusBadge(exec.status)}`}>
                          {exec.status}
                        </span>
                        {exec.retry_count > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            {t('automation.retries')}: {exec.retry_count}
                          </span>
                        )}
                      </div>
                      {exec.output && (
                        <pre className="whitespace-pre-wrap break-all text-[11px] opacity-80">
                          {exec.output}
                        </pre>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              选择一个任务查看执行日志
            </div>
          )}
        </div>
      </div>

      {/* Add/Edit Task Dialog */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowForm(false)}>
          <div
            className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold mb-4">
              {editTask ? t('automation.edit') : t('automation.add_task')}
            </h2>
            <div className="flex flex-col gap-4">
              <div>
                <label className="text-sm font-medium">{t('automation.name')}</label>
                <Input
                  className="mt-1"
                  placeholder={t('automation.name_placeholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium">{t('automation.command')}</label>
                <Input
                  className="mt-1 font-mono text-xs"
                  placeholder={t('automation.command_placeholder')}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium">{t('automation.cron')}</label>
                <Input
                  className="mt-1 font-mono text-xs"
                  placeholder={t('automation.cron_placeholder')}
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                />
                <div className="mt-2 flex flex-wrap gap-1">
                  {CRON_PRESETS.map((p) => (
                    <Button
                      key={p.expr}
                      size="sm"
                      variant="outline"
                      className="h-5 text-[10px] px-1.5"
                      onClick={() => setCronExpr(p.expr)}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
                {t('automation.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={!name.trim() || !command.trim() || !cronExpr.trim()}
              >
                {t('automation.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
