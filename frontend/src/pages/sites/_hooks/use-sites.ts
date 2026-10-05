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
import { buildSiteBlock, type SiteTemplate } from '../_lib/site-template';

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
  // 默认走规范模板：新加的站点应当和现网那些长得一样，而不是一条裸的 reverse_proxy。
  const [newTemplate, setNewTemplate] = useState<SiteTemplate>('standard');

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
    async (action: 'start' | 'stop' | 'reload') => {
      try {
        await postServerAction(action);
        setMsg(t(`sites.${action}_success`));
        setTimeout(() => fetchAll(), 500);
      } catch {
        setMsg(t('sites.action_fail'));
      }
    },
    [fetchAll, t],
  );

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setMsg(t('sites.install_doing'));
    try {
      await installGateway();
      setMsg(t('sites.install_success'));
      fetchAll();
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

  const handleAddSite = useCallback(async () => {
    if (!newDomain || !newTarget) return;
    const block = buildSiteBlock({
      domain: newDomain.trim(),
      type: newType,
      target: newTarget.trim(),
      template: newTemplate,
    });
    // 基于编辑器里的内容拼（而不是服务端那份），否则会把用户还没保存的手改覆盖掉。
    const updated = (rawEditor || config?.raw || '').replace(/\n*$/, '') + '\n\n' + block + '\n';

    try {
      // 以前这里只往编辑器的缓冲区里追加文本、不落盘：点在「可视化管理」下加站点，
      // 什么都不会发生（列表不变、文件也没写），得再切到「配置文件」手动保存一次。
      await saveGatewayConfig(updated);
      // 存完取回服务端格式化后的版本，本地拼的缩进和真实文件才对得上。
      const fresh = await fetchGatewayConfig();
      setConfig(fresh);
      setRawEditor(fresh.raw);
      setNewDomain('');
      setNewTarget('');
      setShowAdd(false);
      setMsg(t('sites.saved_reload'));
    } catch (e) {
      setMsg(`${t('sites.save_fail')}: ${e instanceof Error ? e.message : ''}`);
    }
  }, [newDomain, newType, newTarget, newTemplate, rawEditor, config, fetchAll, t]);

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
    newTemplate,
    setNewTemplate,
    serverAction,
    handleInstall,
    saveConfig,
    handleAddSite,
  };
}
