/**
 * 本地化体检。
 *
 * 为什么要有这个脚本：上一次我"检查过了"，其实是假的 —— 只 grep 了字面量
 * `t('xxx')`，于是
 *
 *   1. `t(labelKey)` 这种**间接**取法完全没查（Dock 上直接显示 `nav.apps`）；
 *   2. key 落在哪一层没查（我把 nav.apps 写进了 `perm` 里，而不是根 `nav`）；
 *   3. 后端给的 id（权限、工具名）对应的标签没查。
 *
 * 这里把这三种都当成错误报出来。用法：`npm run i18n:check`（或 node 直接跑）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolvePath(here, '..');
const src = join(root, 'src');
const repo = resolvePath(root, '..');

const zh = JSON.parse(readFileSync(join(src, 'i18n/zh.json'), 'utf-8'));
const en = JSON.parse(readFileSync(join(src, 'i18n/en.json'), 'utf-8'));

/**
 * 按 i18next 的规则取一个 key：先按嵌套路径走，某一层找不到时再试"带点的字面量键"
 * （资源文件里 `perm` 下就存着 `"nav.agent"` 这种）。
 */
function resolve(obj, key) {
  if (obj == null || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  const i = key.indexOf('.');
  if (i < 0) return undefined;
  return resolve(obj[key.slice(0, i)], key.slice(i + 1));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const errors = [];
const prefixes = [];
const warnings = [];
const seen = new Set();

for (const file of walk(src)) {
  if (file.includes('/i18n/')) continue;
  const text = readFileSync(file, 'utf-8');
  const rel = file.slice(root.length + 1);
  const keys = new Set();

  // 1) t('key') / i18n.t('key')
  for (const m of text.matchAll(/\b(?:i18n\.)?t\(\s*['"]([\w.-]+)['"]/g)) keys.add(m[1]);
  // 2) labelKey: 'nav.apps' —— Dock / 菜单 / 侧栏都走这种间接取法。
  //    不带点的（`labelKey: 'images'`）只是拼在模板里的片段，由第 3 条覆盖。
  for (const m of text.matchAll(/labelKey\s*[:=]\s*['"]([\w.-]+)['"]/g)) {
    if (m[1].includes('.')) keys.add(m[1]);
  }
  // 3) t(`prefix.${x}`)：查前缀那一层是否存在（叶子是动态的，查不到）
  for (const m of text.matchAll(/\bt\(\s*`([\w.-]+)\.\$\{/g)) prefixes.push([rel, m[1]]);

  for (const key of keys) {
    if (key.endsWith('.*')) continue;
    seen.add(key);
    if (resolve(zh, key) === undefined) errors.push(`${rel}: 中文缺少 key \`${key}\``);
    if (resolve(en, key) === undefined && !key.startsWith('tools.')) {
      warnings.push(`${rel}: 英文缺少 key \`${key}\`（会退回中文）`);
    }
  }
}

for (const [rel, prefix] of prefixes) {
  // tools.* 只在英文里：中文走 t('tools.x', { defaultValue: 服务端描述 })，故意的。
  if (prefix === 'tools') continue;
  for (const [lang, dict] of [['中文', zh], ['英文', en]]) {
    const node = resolve(dict, prefix);
    if (node === undefined || typeof node !== 'object') {
      errors.push(`${rel}: ${lang}缺少命名空间 \`${prefix}.*\``);
    }
  }
}

// 后端定义的权限 id，成员页要按 id 显示人话。
const permSrc = readFileSync(join(repo, 'src/domain/permission.rs'), 'utf-8');
for (const m of permSrc.matchAll(/pub const [A-Z_]+: &str = "([\w.]+)";/g)) {
  const id = m[1];
  if (!id.includes('.')) continue;
  for (const [lang, dict] of [['中文', zh], ['英文', en]]) {
    if (resolve(dict, `perm.${id}`) === undefined) {
      errors.push(`${lang}缺少权限标签 \`perm.${id}\``);
    }
  }
}

// 后端工具目录：英文描述可以缺（中文会退回服务端原文），但缺了要提醒。
const mcpSrc = readFileSync(join(repo, 'src/http/handlers/mcp.rs'), 'utf-8');
for (const m of mcpSrc.matchAll(/name:\s*"(ops_[a-z_]+)"/g)) {
  if (resolve(en, `tools.${m[1]}`) === undefined) {
    warnings.push(`英文缺少工具描述 \`tools.${m[1]}\`（会显示服务端的中文）`);
  }
}

console.log(`检查了 ${seen.size} 个界面 key、权限标签、工具描述`);
if (warnings.length) {
  console.log('\n⚠️  警告');
  for (const w of warnings) console.log('  -', w);
}
if (errors.length) {
  console.log('\n❌ 错误');
  for (const e of errors) console.log('  -', e);
  process.exit(1);
}
console.log('\n✅ 没有缺失的 key');
