import { create } from 'zustand';
import { get } from '../lib/api';

type PanelBits = { title?: string; domain?: string };

type State = {
  title: string;
  domain: string;
  loaded: boolean;
  load: () => Promise<void>;
  apply: (next: PanelBits) => void;
};

/** 面板标题和「这是面板入口」的域名。顶栏、站点列表、首页入口读同一份。 */
export const usePanelPrefs = create<State>((set, getState) => ({
  title: '',
  domain: '',
  loaded: false,
  load: async () => {
    if (getState().loaded) return;
    try {
      const res = await get<PanelBits>('/system/panel');
      if (res.success && res.data) {
        set({
          title: res.data.title ?? '',
          domain: res.data.domain ?? '',
          loaded: true,
        });
      }
    } catch {
      /* 顶栏没有标题就用 ZOPS，不挡页面 */
    }
  },
  apply: (next) =>
    set((s) => ({
      title: next.title ?? s.title,
      domain: next.domain ?? s.domain,
      loaded: true,
    })),
}));

export function isPanelHost(addr: string, domain: string) {
  const norm = (s: string) => s.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return domain.trim() !== '' && norm(addr) === norm(domain);
}
