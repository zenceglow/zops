import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import useAuthorizeStore from '../../../stores/authorize.store';
import { sshWsUrl, type SshClientMsg, type SshServerMsg } from '../_api';

export type ConnectForm = {
  host: string;
  port: number;
  username: string;
  password: string;
};

/**
 * local：直接开本机 shell，不碰网络，也不需要凭据。
 * remote：对方是另一台机器，按 SSH 正常认证。
 */
export type ConnectMode = 'local' | 'remote';

export function useSshTerminal() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState('');
  const [mode, setMode] = useState<ConnectMode>('local');
  const [form, setForm] = useState<ConnectForm>({
    // 不预填 127.0.0.1：本机模式根本用不到主机，而在远程模式下预填本机地址
    // 只会让人以为"远程连自己"，何况后端认得出本机、会直接走本地 shell。
    host: '',
    port: 22,
    username: 'root',
    password: '',
  });

  const send = useCallback((msg: SshClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
    setConnecting(false);
  }, []);

  const connect = useCallback(() => {
    const token = useAuthorizeStore.getState().token;
    if (!token) {
      setStatus(t('ssh.status_need_login'));
      return;
    }
    // 本机模式没有主机和用户名可填，那两栏的校验只对远程生效。
    const local = mode === 'local';
    if (!local && (!form.host.trim() || !form.username.trim())) {
      setStatus(t('ssh.status_need_fields'));
      return;
    }

    disconnect();
    setConnecting(true);
    setStatus(t('ssh.status_connecting'));

    const term = termRef.current;
    const fit = fitRef.current;
    if (term && fit) {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      term.clear();
      term.focus();
    }

    const ws = new WebSocket(sshWsUrl(token));
    wsRef.current = ws;

    ws.onopen = () => {
      const cols = term?.cols ?? 80;
      const rows = term?.rows ?? 24;
      send({
        type: 'connect',
        // 后端认这几个写法为"本机"，走本地 PTY，凭据字段会被忽略。
        host: local ? 'localhost' : form.host.trim(),
        port: local ? 22 : form.port || 22,
        username: local ? '' : form.username.trim(),
        password: local ? '' : form.password,
        cols,
        rows,
      });
    };

    ws.onmessage = (ev) => {
      let msg: SshServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as SshServerMsg;
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        setConnected(true);
        setConnecting(false);
        setStatus(t('ssh.status_connected'));
        term?.focus();
      } else if (msg.type === 'output') {
        term?.write(msg.data);
      } else if (msg.type === 'error') {
        setStatus(msg.message);
        setConnecting(false);
        term?.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
      } else if (msg.type === 'closed') {
        setConnected(false);
        setConnecting(false);
        setStatus(t('ssh.status_closed'));
        term?.writeln('\r\n\x1b[33m[session closed]\x1b[0m');
      }
    };

    ws.onerror = () => {
      setConnecting(false);
      setStatus(t('ssh.status_ws_error'));
    };

    ws.onclose = () => {
      setConnected(false);
      setConnecting(false);
      wsRef.current = null;
    };
  }, [disconnect, form, mode, send, t]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#0c0c0c',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data } satisfies SshClientMsg));
      }
    });

    const onResize = () => {
      try {
        fit.fit();
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'resize',
              cols: term.cols,
              rows: term.rows,
            } satisfies SshClientMsg),
          );
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [disconnect]);

  return {
    containerRef,
    form,
    setForm,
    mode,
    setMode,
    connected,
    connecting,
    status,
    connect,
    disconnect,
  };
}
