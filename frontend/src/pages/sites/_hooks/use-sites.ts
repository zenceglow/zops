import { useCallback, useEffect, useState } from 'react';
import { toast } from '../../../components/ui/sonner';
import { useTranslation } from 'react-i18next';
import {
  fetchGatewayConfig,
  fetchGatewayStatus,
  fetchCaddyfileVersions,
  installGateway,
  restoreCaddyfileVersion,
  saveGatewayConfig,
  serverAction as postServerAction,
  type CaddyfileVersion,
  type GatewayConfig,
  type GatewayStatus,
} from '../_api';
import { buildSiteBlock, type SiteTemplate } from '../_lib/site-template';

export function useSites() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [rawEditor, setRawEditor] = useState('');
  /** list = 入口列表；editor = 直接改配置文件。 */
  const [mode, setMode] = useState<'list' | 'editor'>('list');
  const [versions, setVersions] = useState<CaddyfileVersion[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [installing, setInstalling] = useState(false);
  /** 启动/停止/重载正在进行。按钮点下去到状态回读之间会有空档，不能让人连点。 */
  const [acting, setActing] = useState(false);
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

  const loadVersions = useCallback(() => {
    setLoadingVersions(true);
    fetchCaddyfileVersions()
      .then(setVersions)
      .catch(() => setVersions([]))
      .finally(() => setLoadingVersions(false));
  }, []);

  const serverAction = useCallback(
    async (action: 'start' | 'stop' | 'reload') => {
      setActing(true);
      try {
        await postServerAction(action);
        toast.success(t(`sites.${action}_success`));
        setTimeout(() => fetchAll(), 500);
      } catch (e) {
        // 带上后端原话：它知道是"配置文件不存在"还是"权限不够"，一句"操作失败"等于没说。
        toast.error(`${t('sites.action_fail')}：${e instanceof Error ? e.message : ''}`);
      } finally {
        setActing(false);
      }
    },
    [fetchAll, t],
  );

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      await installGateway();
      toast.success(t('sites.install_success'));
      fetchAll();
    } catch {
      toast.error(t('sites.install_fail'));
    }
    setInstalling(false);
  }, [fetchAll, t]);

  const saveConfig = useCallback(async () => {
    try {
      await saveGatewayConfig(rawEditor);
      toast.success(t('sites.saved_reload'));
      fetchAll();
    } catch (e) {
      toast.error(`${t('sites.save_fail')}: ${e instanceof Error ? e.message : ''}`);
    }
  }, [rawEditor, fetchAll, t]);

  const restoreVersion = useCallback(
    async (id: number) => {
      try {
        await restoreCaddyfileVersion(id);
        const fresh = await fetchGatewayConfig();
        setConfig(fresh);
        setRawEditor(fresh.raw);
        toast.success(t('sites.restore_success'));
        fetchAll();
        loadVersions();
      } catch (e) {
        toast.error(`${t('sites.restore_fail')}: ${e instanceof Error ? e.message : ''}`);
      }
    },
    [fetchAll, loadVersions, t],
  );

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
      toast.success(t('sites.saved_reload'));
    } catch (e) {
      toast.error(`${t('sites.save_fail')}: ${e instanceof Error ? e.message : ''}`);
    }
  }, [newDomain, newType, newTarget, newTemplate, rawEditor, config, fetchAll, t]);

  return {
    status,
    config,
    rawEditor,
    setRawEditor,
    mode,
    setMode,
    versions,
    loadingVersions,
    loadVersions,
    restoreVersion,
    installing,
    acting,
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
