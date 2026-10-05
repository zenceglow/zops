import { useCallback, useEffect, useState } from 'react';
import { toast } from '../../../components/ui/sonner';
import { useTranslation } from 'react-i18next';
import {
  addSite as postAddSite,
  deleteSite as postDeleteSite,
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

    try {
      // 交给后端：它会先查重（同名站点 Caddy 会拒绝加载**整份**配置），
      // 再包上 ZOPS 标记、校验、落盘。以前这里是前端拼字符串直接覆盖整个
      // 文件 —— 拼错了没人拦，写进去就是全站下线。
      await postAddSite(newDomain.trim(), block);
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

  /** 删掉一个站点。只动它自己那一段（后端按标记/行范围切）。 */
  const removeSite = useCallback(
    async (addr: string) => {
      try {
        await postDeleteSite(addr);
        const fresh = await fetchGatewayConfig();
        setConfig(fresh);
        setRawEditor(fresh.raw);
        toast.success(t('sites.deleted', { addr }));
      } catch (e) {
        toast.error(`${t('sites.delete_fail')}: ${e instanceof Error ? e.message : ''}`);
      }
    },
    [t],
  );

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
    removeSite,
  };
}
