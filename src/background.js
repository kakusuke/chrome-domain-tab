import { parseTabUrl, compareStr, compareLabels, colorFor, toBlocks } from './domain.js';

// タブ数がこれ未満のサイトはグループにしない
const MIN_GROUP_SIZE = 2;
const DEBOUNCE_MS = 300;
// タブをドラッグ中は編集できないので、少し待ってからやり直す
const DRAG_RETRY_MS = 500;
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;
const NO_SPLIT = chrome.tabs.SPLIT_VIEW_ID_NONE ?? -1;

const timers = new Map();
const running = new Set();
const pending = new Set();

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

async function init() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  for (const win of windows) schedule(win.id);
}

chrome.tabs.onCreated.addListener((tab) => schedule(tab.windowId));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url !== undefined || info.pinned !== undefined || info.splitViewId !== undefined) schedule(tab.windowId);
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (!info.isWindowClosing) schedule(info.windowId);
});
chrome.tabs.onAttached.addListener((tabId, info) => schedule(info.newWindowId));
chrome.tabs.onDetached.addListener((tabId, info) => schedule(info.oldWindowId));
chrome.tabGroups.onRemoved.addListener((group) => forgetGroup(group.id));

function schedule(windowId, delay = DEBOUNCE_MS) {
  clearTimeout(timers.get(windowId));
  timers.set(windowId, setTimeout(() => {
    timers.delete(windowId);
    run(windowId);
  }, delay));
}

async function run(windowId) {
  if (running.has(windowId)) {
    pending.add(windowId);
    return;
  }
  running.add(windowId);
  try {
    await organize(windowId);
  } catch (e) {
    if (/dragging/i.test(e.message)) schedule(windowId, DRAG_RETRY_MS);
    else if (!/^No (window|tab|group)/.test(e.message)) console.error(e);
  } finally {
    running.delete(windowId);
    if (pending.delete(windowId)) schedule(windowId);
  }
}

async function organize(windowId) {
  const win = await chrome.windows.get(windowId);
  if (win.type !== 'normal') return;

  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ]);
  const managed = await loadManagedGroups(groups, tabs);

  // 拡張が作ったグループとグループ外のタブだけを扱う。ユーザーが作ったグループには触らない。
  const targets = tabs.filter((t) => !t.pinned && (t.groupId === NO_GROUP || managed.has(t.groupId)));
  const sites = new Map();
  const strays = [];
  for (const block of toBlocks(targets, NO_SPLIT)) {
    const parsed = block.map((tab) => parseTabUrl(tab.pendingUrl || tab.url));
    // 分割ビューは左側のタブ（http(s) でなければ右側）のサイトに入れる
    const first = parsed.find(Boolean);
    if (!first) {
      strays.push(...block.filter((t) => t.groupId !== NO_GROUP).map((t) => t.id));
      continue;
    }
    let site = sites.get(first.siteLabel);
    if (!site) sites.set(first.siteLabel, site = { site: first.site, siteLabel: first.siteLabel, entries: [], size: 0 });
    site.entries.push({ tabs: block, parsed: first });
    // グループを作るかどうかは、そのサイトのタブだけで数える
    site.size += parsed.filter((p) => p?.siteLabel === first.siteLabel).length;
  }
  if (strays.length) await chrome.tabs.ungroup(strays);

  const ids = (entry) => entry.tabs.map((t) => t.id);
  const units = [];
  const sorted = [...sites.values()].sort((a, b) => compareStr(a.siteLabel, b.siteLabel));
  for (const site of sorted) {
    site.entries.sort((a, b) => compareLabels(a.parsed.subLabels, b.parsed.subLabels) || a.tabs[0].index - b.tabs[0].index);
    const members = site.entries.flatMap((e) => e.tabs);
    if (site.size >= MIN_GROUP_SIZE) {
      const groupId = await ensureGroup(site, members, groups, managed, windowId);
      units.push({ groupId, blocks: site.entries.map(ids) });
    } else {
      const grouped = members.filter((t) => t.groupId !== NO_GROUP).map((t) => t.id);
      if (grouped.length) await chrome.tabs.ungroup(grouped);
      for (const entry of site.entries) units.push({ blocks: [ids(entry)] });
    }
  }
  await rememberGroups(managed);

  const pinnedCount = tabs.filter((t) => t.pinned).length;
  await arrange(windowId, units, pinnedCount);
}

async function ensureGroup(site, members, groups, managed, windowId) {
  const existing = groups.find((g) => managed.has(g.id) && g.title === site.siteLabel);
  if (existing) {
    const missing = members.filter((t) => t.groupId !== existing.id).map((t) => t.id);
    if (missing.length) await chrome.tabs.group({ groupId: existing.id, tabIds: missing });
    return existing.id;
  }
  const tabIds = members.map((t) => t.id);
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: site.siteLabel, color: colorFor(site.site) });
  managed.add(groupId);
  return groupId;
}

/**
 * ピン留めタブの直後から、サイト順・サブドメイン順にタブとグループを並べる。
 * 左から順に確定させるので、移動はいつも左向きになる。それ以外のタブは右側に寄る。
 * 分割ビューの2枚は1つのブロックとしてまとめて動かす（1枚ずつ動かすと分割ビューから外れてしまう）。
 */
async function arrange(windowId, units, start) {
  let index = start;
  for (const { groupId, blocks } of units) {
    if (groupId !== undefined) {
      const members = await chrome.tabs.query({ windowId, groupId });
      const groupStart = Math.min(...members.map((t) => t.index));
      if (groupStart !== index) await chrome.tabGroups.move(groupId, { index });
    }
    for (const block of blocks) {
      const current = await Promise.all(block.map((id) => chrome.tabs.get(id)));
      if (current.some((t, i) => t.index !== index + i)) await chrome.tabs.move(block, { index });
      index += block.length;
    }
    if (groupId !== undefined) {
      // 並べ替えの途中でグループから外れたタブを戻す。分割ビューの片方だけは戻せないので全員まとめて指定する
      const tabIds = blocks.flat();
      const current = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
      if (current.some((t) => t.groupId !== groupId)) await chrome.tabs.group({ groupId, tabIds });
    }
  }
}

// ブラウザを再起動するとグループ ID が変わるので、タイトルがタブのサイト名と一致するグループも管理対象とみなす
async function loadManagedGroups(groups, tabs) {
  const { managedGroups = [] } = await chrome.storage.session.get('managedGroups');
  const stored = new Set(managedGroups);
  const managed = new Set();
  for (const group of groups) {
    const titleMatches = tabs.some((t) => t.groupId === group.id && parseTabUrl(t.pendingUrl || t.url)?.siteLabel === group.title);
    if (stored.has(group.id) || titleMatches) managed.add(group.id);
  }
  return managed;
}

async function rememberGroups(ids) {
  const { managedGroups = [] } = await chrome.storage.session.get('managedGroups');
  const merged = new Set([...managedGroups, ...ids]);
  await chrome.storage.session.set({ managedGroups: [...merged] });
}

async function forgetGroup(id) {
  const { managedGroups = [] } = await chrome.storage.session.get('managedGroups');
  await chrome.storage.session.set({ managedGroups: managedGroups.filter((g) => g !== id) });
}
