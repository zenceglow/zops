export type Deduction = {
  /** i18n 后缀：home.deduct_<key> */
  key: string;
  value: number;
  points: number;
};

export type HealthScore = {
  score: number;
  grade: 'good' | 'fair' | 'poor';
  deductions: Deduction[];
};

/**
 * 把几项占用折算成一个 0-100 的"运行评分"。
 *
 * 规则是明码写的扣分制，不是拍一个公式：每项占用过了阈值扣固定分，磁盘扣得最重
 * （满了是真写不进东西），CPU/负载最轻（短时冲高很正常）。这样界面能直接说清
 * "为什么是这个分" —— 一个解释不了的数字，用户看两次就不看了。
 */
export function computeHealthScore(m: {
  cpu: number;
  loadPct: number;
  memory: number;
  disk: number;
  swap: number;
  /** 待修复的安全补丁数。 */
  security?: number;
}): HealthScore {
  type Metric = 'cpu' | 'loadPct' | 'memory' | 'disk' | 'swap';
  const rules: [Metric, number, number, number, number][] = [
    // [指标, 严重阈值, 严重扣分, 警告阈值, 警告扣分]
    ['disk', 90, 25, 80, 12],
    ['memory', 90, 15, 80, 8],
    ['swap', 90, 15, 75, 8],
    ['cpu', 90, 15, 75, 8],
    ['loadPct', 100, 10, 80, 5],
  ];

  const deductions: Deduction[] = [];
  for (const [key, hardAt, hard, softAt, soft] of rules) {
    const value = m[key];
    if (value >= hardAt) deductions.push({ key, value, points: hard });
    else if (value >= softAt) deductions.push({ key, value, points: soft });
  }

  // 补丁单独处理：它不是"占用"，是"风险"。攒着不修本身就是扣分项，而且积得越多
  // 扣得越狠 —— 这也是"定期检查补丁"唯一对用户有意义的地方。
  const security = m.security ?? 0;
  if (security >= 10) deductions.push({ key: 'security', value: security, points: 15 });
  else if (security >= 3) deductions.push({ key: 'security', value: security, points: 8 });
  else if (security >= 1) deductions.push({ key: 'security', value: security, points: 4 });

  const score = Math.max(0, Math.round(100 - deductions.reduce((s, d) => s + d.points, 0)));
  const grade: HealthScore['grade'] = score >= 85 ? 'good' : score >= 70 ? 'fair' : 'poor';
  return { score, grade, deductions };
}
