import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchGatewayConfig,
  fetchGatewayStatus,
  installGateway,
  saveGatewayConfig,
  serverAction as postServerAction,
  type GatewayConfig,
  type GatewayStatus,
} from '../_api';

export function useSites() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [rawEditor, setRawEditor] = useState('');
  const [tab, setTab] = useState('visual');
  const [msg, setMsg] = useState('');
  const [installing, setInstalling] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [newType, setNewType] = useState<'proxy' | 'static'>('proxy');
  const [newTarget, setNewTarget] = useState('');

  const fetchAll = useCallback(() => {
    fetchGatewayStatus().then(setStatus).catch(() => {});
    fetchGatewayConfig()
      .then((d) => {
        setConfig(d);
        setRawEditor(d.raw);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const serverAction = useCallback(
    async (action: string) => {
      const res = await postServerAction(action);
      if (res?.ok) {
        setMsg(t(`sites.${action}_success`));
        setTimeout(() => fetchAll(), 500);
      } else {
        setMsg(t('sites.action_fail'));
      }
    },
    [fetchAll, t],
  );

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setMsg(t('sites.install_doing'));
    try {
      const res = await installGateway();
      if (res?.ok) {
        setMsg(t('sites.install_success'));
        fetchAll();
      } else {
        setMsg(t('sites.install_fail'));
      }
    } catch {
      setMsg(t('sites.install_fail'));
    }
    setInstalling(false);
  }, [fetchAll, t]);

  const saveConfig = useCallback(async () => {
    try {
      await saveGatewayConfig(rawEditor);
      setMsg(t('sites.saved_reload'));
      fetchAll();
    } catch (e) {
      setMsg(`${t('sites.save_fail')}: ${e instanceof Error ? e.message : ''}`);
    }
  }, [rawEditor, fetchAll, t]);

  const handleAddSite = useCallback(() => {
    if (!newDomain || !newTarget) return;
    const line =
      newType === 'proxy'
        ? `${newDomain} {\n    reverse_proxy ${newTarget}\n}`
        : `${newDomain} {\n    root * ${newTarget}\n    file_server\n}`;
    const updated = (rawEditor || config?.raw || '').replace(/\n*$/, '') + '\n\n' + line + '\n';
    setRawEditor(updated);
    setNewDomain('');
    setNewTarget('');
    setShowAdd(false);
    setMsg(t('sites.saved_reload'));
  }, [newDomain, newType, newTarget, rawEditor, config, t]);

  return {
    status,
    config,
    rawEditor,
    setRawEditor,
    tab,
    setTab,
    msg,
    installing,
    showAdd,
    setShowAdd,
    newDomain,
    setNewDomain,
    newType,
    setNewType,
    newTarget,
    setNewTarget,
    serverAction,
    handleInstall,
    saveConfig,
    handleAddSite,
  };
}
