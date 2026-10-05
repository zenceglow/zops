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

/** "别再提醒这个版本" —— 点了它就一直安静到下次真的发新版。 */
const SKIP_KEY = 'zops.update.skip';

/**
 * "稍后" 和点遮罩关掉走这里：只压一天，不是永远。
 *
 * 原来所有关闭动作都等于"永不再提"，所以文案只能写"不再提醒"，又长又劝退；
 * 而且手滑按到 Esc 就再也收不到更新提示了 —— 一个提示组件不该有这种暗雷。
 */
const SNOOZE_KEY = 'zops.update.snooze';
const SNOOZE_MS = 24 * 60 * 60 * 1000;

/** 半小时问一次服务端。真正出门拉 CDN 的节奏由服务端控制（6 小时）。 */
const POLL_MS = 30 * 60 * 1000;

export function useRelease() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() =>
    localStorage.getItem(SKIP_KEY),
  );
  const [snoozedAt, setSnoozedAt] = useState<number>(() =>
    Number(localStorage.getItem(SNOOZE_KEY) ?? 0),
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

  const snooze = () => {
    const now = Date.now();
    localStorage.setItem(SNOOZE_KEY, String(now));
    setSnoozedAt(now);
  };

  // 半小时一次轮询会重新渲染，所以"压了一天"到期后自会重新冒出来，不用定时器。
  const snoozed = snoozedAt > 0 && Date.now() - snoozedAt < SNOOZE_MS;
  const show = !!status?.has_update && status.latest !== dismissed && !snoozed;
  return { status, show, skip, snooze };
}
