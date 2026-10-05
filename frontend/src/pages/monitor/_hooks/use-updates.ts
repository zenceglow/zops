import { useEffect, useState } from 'react';
import { fetchUpdates } from '../../system/updates/_api';

/** 首页只需要"待修复的补丁数"这一项，用来算运行评分。 */
export function useSecurityUpdates() {
  const [security, setSecurity] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchUpdates()
        .then((r) => alive && setSecurity(r.security))
        .catch(() => {});
    load();
    // 服务端六小时才刷一次缓存，这里五分钟问一次足够，也不会造成负担。
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return security;
}
