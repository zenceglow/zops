import type { ComponentType } from 'react';

export type SidebarLeaf = {
  path: string;
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
  perm: string;
};

export type SidebarParent = {
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
  perm: string;
  children: SidebarLeaf[];
};

export type SidebarItem = SidebarLeaf | SidebarParent;

export type SidebarGroup = {
  labelKey: string;
  items: SidebarItem[];
};

export function isParent(item: SidebarItem): item is SidebarParent {
  return 'children' in item;
}

/* ---------- derived helpers ---------- */

function collectLeaves(groups: SidebarGroup[]): SidebarLeaf[] {
  const leaves: SidebarLeaf[] = [];
  for (const g of groups) {
    for (const item of g.items) {
      if (isParent(item)) {
        leaves.push(...item.children);
      } else {
        leaves.push(item);
      }
    }
  }
  return leaves;
}

export function buildPermMap(groups: SidebarGroup[]): Record<string, string> {
  const leaves = collectLeaves(groups);
  const map: Record<string, string> = {};
  const sorted = [...leaves].sort((a, b) => b.path.length - a.path.length);
  for (const leaf of sorted) {
    map[leaf.path] = leaf.perm;
  }
  return map;
}

const EXACT_PATHS = new Set(['/monitor', '/ssh', '/members', '/files', '/logs']);

export function pathMatches(pathname: string, p: string): boolean {
  if (EXACT_PATHS.has(p)) return pathname === p;
  return pathname.startsWith(p);
}

export function pathPermission(
  pathname: string,
  permMap: Record<string, string>,
): string | null {
  const keys = Object.keys(permMap).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (pathMatches(pathname, k)) return permMap[k] ?? null;
  }
  return null;
}

export function firstAllowedPath(
  groups: SidebarGroup[],
  hasPermission: (p: string) => boolean,
): string {
  const leaves = collectLeaves(groups);
  for (const leaf of leaves) {
    if (hasPermission(leaf.perm)) return leaf.path;
  }
  return '/login';
}
