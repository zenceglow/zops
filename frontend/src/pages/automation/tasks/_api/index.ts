import { del, get, post, put } from '../../../../lib/api';
import type { ApiResultType } from '../../../../lib/types/api-response';

export interface AutomationTask {
  id: string;
  name: string;
  command: string;
  cron_expr: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskExecution {
  id: string;
  task_id: string;
  status: 'running' | 'success' | 'failed';
  output: string;
  started_at: string;
  finished_at: string | null;
  retry_count: number;
}

export function listTasks(): Promise<ApiResultType<AutomationTask[]>> {
  return get<AutomationTask[]>('/automation/tasks');
}

export function createTask(body: {
  name: string;
  command: string;
  cron_expr: string;
  enabled?: boolean;
}): Promise<ApiResultType<AutomationTask>> {
  return post<AutomationTask>('/automation/tasks', body);
}

export function updateTask(
  id: string,
  body: {
    name?: string;
    command?: string;
    cron_expr?: string;
    enabled?: boolean;
  },
): Promise<ApiResultType<AutomationTask>> {
  return put<AutomationTask>(`/automation/tasks/${id}`, body);
}

export function deleteTask(id: string): Promise<ApiResultType<null>> {
  return del<null>('/automation/tasks', { id });
}

export function runTaskNow(id: string): Promise<ApiResultType<TaskExecution>> {
  return post<TaskExecution>(`/automation/tasks/${id}/run`);
}

export function listExecutions(
  taskId: string,
  limit?: number,
): Promise<ApiResultType<TaskExecution[]>> {
  return get<TaskExecution[]>(`/automation/tasks/${taskId}/executions`, { limit });
}
