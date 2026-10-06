import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { encryptedLocalStorage } from '../lib/secure-storage';

/**
 * 连接（MCP 令牌）的明文留底：`token id → ops_…`。
 *
 * 服务端只存 SHA-256，令牌本来"只显示这一次"。但那样一来卡片上的"复制连接方式"
 * 刷新一次就废了 —— 用户要的是"存成卡片，随时复制给 agent"。所以在**创建它的那台
 * 浏览器**上留一份底（和登录态一样走加密的持久化存储），随时能再复制，删连接时一起删。
 *
 * 不回传服务器：留底只为了下次复制，不改变"服务端只有哈希"这件事。
 */
interface McpConnectionsStore {
  tokens: Record<string, string>;
  remember: (id: string, token: string) => void;
  forget: (id: string) => void;
}

const useMcpConnections = create<McpConnectionsStore>()(
  persist(
    (set) => ({
      tokens: {},
      remember: (id, token) =>
        set((s) => ({ tokens: { ...s.tokens, [id]: token } })),
      forget: (id) =>
        set((s) => {
          const next = { ...s.tokens };
          delete next[id];
          return { tokens: next };
        }),
    }),
    {
      name: 'ops-mcp-connections',
      storage: createJSONStorage(() => encryptedLocalStorage),
    },
  ),
);

export default useMcpConnections;
