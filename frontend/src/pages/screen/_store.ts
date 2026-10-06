import { create } from 'zustand';
import {
  fetchEvents,
  fetchOverview,
  fetchSystemOverview,
  type AccessEvent,
  type AnalyticsOverview,
  type SystemOverview,
} from './_api';

/** 实时流水轮询间隔。 */
const EVENT_POLL_MS = 3000;
/** 底部流水保留多少条。 */
export const MAX_ROWS = 40;
/** 概览刷新比流水慢：数字跳太频反而看不出趋势。 */
const OVERVIEW_EVERY = 5;

/**
 * 大屏的数据源。
 *
 * 之前这些 state 全在页面组件里，于是**任何一个数字变一下，整页都会重绘**：
 * 时钟每跳一秒，地球、流水列表、压力仪、二十几个滚动数字全部跟着走一遍。这台屏
 * 是 24 小时挂着的，每秒一次的整树重绘既费电又让动画掉帧。
 *
 * 现在数据放在这个 store 里，各块用**选择器**只订阅自己那一份：系统指标变了只
 * 重画压力仪，新日志来了只动流水（外加地球那一条新弧线），时钟更是完全独立 ——
 * 谁的数据谁重绘，互不牵连。
 */
type ScreenState = {
  hours: number;
  overview: AnalyticsOverview | null;
  events: AccessEvent[];
  /** 最新一条流水的 id。地球只关心"来没来新的"，不关心整个列表变没变。 */
  latestEventId: number | null;
  sys: SystemOverview | null;
  sysDenied: boolean;
  error: string;
  setHours: (hours: number) => void;
};

export const useScreenStore = create<ScreenState>((set) => ({
  hours: 24,
  overview: null,
  events: [],
  latestEventId: null,
  sys: null,
  sysDenied: false,
  error: '',
  setHours: (hours) => set({ hours }),
}));

/** 增量游标：只记在模块里就够了，没有任何组件需要读它。 */
let cursor = 0;

async function loadOverview() {
  const { hours } = useScreenStore.getState();
  try {
    const overview = await fetchOverview(hours);
    useScreenStore.setState({ overview, error: '' });
  } catch (e) {
    useScreenStore.setState({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * 拉增量流水。
 *
 * 只在**前面**接新行：老的几条对象引用原样保留，配合 memo 过的行组件，一次轮询
 * 只有新来的那几行会走渲染 —— 不是把四十行全部重画一遍。
 */
async function loadEvents(seed: boolean) {
  try {
    const page = await fetchEvents(seed ? 0 : cursor, 40);
    cursor = page.cursor;
    if (page.events.length === 0) return;
    const fresh = [...page.events].reverse();
    const prev = useScreenStore.getState().events;
    const merged = (seed ? fresh : [...fresh, ...prev]).slice(0, MAX_ROWS);
    useScreenStore.setState({
      events: merged,
      latestEventId: merged[0]?.id ?? null,
    });
  } catch {
    // 轮询失败不弹窗：大屏上顶个红色提示比数据晚 3 秒更难看。
  }
}

async function loadSys() {
  try {
    const res = await fetchSystemOverview();
    if (res.success && res.data) useScreenStore.setState({ sys: res.data });
    else if (res.code === 403) useScreenStore.setState({ sysDenied: true });
  } catch {
    // 采不到就保持上一次的读数，大屏闪一下空白比数字旧两秒更难看。
  }
}

/**
 * 开始轮询，返回停止函数。
 *
 * 挂在页面的生命周期上：退出大屏即停止，标签页切到后台也停 —— 这块屏常常挂一整天，
 * 没人在看的时候还每 3 秒查一次库是白烧资源。
 */
export function startScreenPolling(): () => void {
  let hidden = document.hidden;
  void loadOverview();
  void loadEvents(true);
  void loadSys();

  let tick = 0;
  const id = setInterval(() => {
    if (hidden) return;
    void loadEvents(false);
    // 压力是秒级变化的东西，和流水同频读；系统指标只是一次 sysinfo 读取，很便宜。
    if (!useScreenStore.getState().sysDenied) void loadSys();
    if (++tick % OVERVIEW_EVERY === 0) void loadOverview();
  }, EVENT_POLL_MS);

  const onVisibility = () => {
    hidden = document.hidden;
    // 切回来立刻补一次，不用干等下一个周期。
    if (!hidden) void loadEvents(false);
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** 切时间范围后重新拉一次概览。流水跟范围无关，不用动。 */
export function reloadOverview() {
  void loadOverview();
}
