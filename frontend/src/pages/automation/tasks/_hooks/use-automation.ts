import { useCallback, useEffect, useState } from 'react';
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  runTaskNow,
  listExecutions,
  type AutomationTask,
  type TaskExecution,
} from '../_api';
import { toast } from 'sonner';

export function useAutomationTasks() {
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listTasks();
      if (res.success && res.data) setTasks(res.data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 10_000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  const handleCreate = useCallback(
    async (data: { name: string; command: string; cron_expr: string }) => {
      const res = await createTask(data);
      if (res.success && res.data) {
        setTasks((prev) => [...prev, res.data!]);
        toast.success('任务已创建');
      } else {
        toast.error(res.message || '创建失败');
      }
    },
    [],
  );

  const handleUpdate = useCallback(
    async (id: string, data: { name?: string; command?: string; cron_expr?: string; enabled?: boolean }) => {
      const res = await updateTask(id, data);
      if (res.success && res.data) {
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...res.data! } : t)));
        toast.success('已更新');
      } else {
        toast.error(res.message || '更新失败');
      }
    },
    [],
  );

  const handleDelete = useCallback(async (id: string) => {
    const res = await deleteTask(id);
    if (res.success) {
      setTasks((prev) => prev.filter((t) => t.id !== id));
      toast.success('已删除');
    } else {
      toast.error(res.message || '删除失败');
    }
  }, []);

  const handleRun = useCallback(async (id: string) => {
    const res = await runTaskNow(id);
    if (res.success) {
      toast.success('任务已触发');
      await fetchTasks();
    } else {
      toast.error(res.message || '触发失败');
    }
  }, [fetchTasks]);

  return { tasks, loading, handleCreate, handleUpdate, handleDelete, handleRun, refresh: fetchTasks };
}

export function useTaskExecutions(taskId: string | null) {
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const res = await listExecutions(taskId, 50);
      if (res.success && res.data) setExecutions(res.data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (taskId) {
      fetch();
      const interval = setInterval(fetch, 3000);
      return () => clearInterval(interval);
    }
  }, [fetch]);

  return { executions, loading };
}
