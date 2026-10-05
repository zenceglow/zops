import { useEffect, useState } from 'react';
import { get } from '../lib/api';

export type UpdateStatus = {
  current: string;
  /** 拉不到清单时是 null —— 界面据此说"检查不了"，而不是谎报"已是最新"。 */
  latest: string | null;
  has_update: boolean;
  notes: string;
  published_at: string;
  checked_at: string | null;
  install_command: string;
};

/** 关掉某个版本的提示后记在这里，下次不再打扰。 */
const SKIP_KEY = 'zops.update.skip';

/** 半小时问一次服务端。真正出门拉 CDN 的节奏由服务端控制（6 小时）。 */
const POLL_MS = 30 * 60 * 1000;

export function useRelease() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() =>
    localStorage.getItem(SKIP_KEY),
  );

  useEffect(() => {
    let alive = true;
    const load = () => {
      void get<UpdateStatus>('/system/release')
        .then((res) => {
          if (alive && res.success && res.data) setStatus(res.data);
        })
        .catch(() => {
          // 拿不到就当没有新版本：更新提示失败不该在界面上刷存在感。
        });
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const skip = () => {
    if (!status?.latest) return;
    localStorage.setItem(SKIP_KEY, status.latest);
    setDismissed(status.latest);
  };

  const show = !!status?.has_update && status.latest !== dismissed;
  return { status, show, skip };
}
