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

export function useSshTerminal() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState('');
  const [form, setForm] = useState<ConnectForm>({
    host: '127.0.0.1',
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
    if (!form.host.trim() || !form.username.trim()) {
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
        host: form.host.trim(),
        port: form.port || 22,
        username: form.username.trim(),
        password: form.password,
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
  }, [disconnect, form, send, t]);

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
    connected,
    connecting,
    status,
    connect,
    disconnect,
  };
}
