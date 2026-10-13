import { parseTabUrl, compareStr, compareLabels, colorFor } from './domain.js';

// タブ数がこれ未満のサイトはグループにしない
const MIN_GROUP_SIZE = 2;
const DEBOUNCE_MS = 300;
// タブをドラッグ中は編集できないので、少し待ってからやり直す
const DRAG_RETRY_MS = 500;
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;

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
  if (info.url !== undefined || info.pinned !== undefined) schedule(tab.windowId);
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
  const sites = new Map();
  const strays = [];
  for (const tab of tabs) {
    if (tab.pinned) continue;
    if (tab.groupId !== NO_GROUP && !managed.has(tab.groupId)) continue;
    const parsed = parseTabUrl(tab.pendingUrl || tab.url);
    if (!parsed) {
      if (tab.groupId !== NO_GROUP) strays.push(tab.id);
      continue;
    }
    let site = sites.get(parsed.siteLabel);
    if (!site) sites.set(parsed.siteLabel, site = { site: parsed.site, siteLabel: parsed.siteLabel, entries: [] });
    site.entries.push({ tab, parsed });
  }
  if (strays.length) await chrome.tabs.ungroup(strays);

  const units = [];
  const sorted = [...sites.values()].sort((a, b) => compareStr(a.siteLabel, b.siteLabel));
  for (const site of sorted) {
    site.entries.sort((a, b) => compareLabels(a.parsed.subLabels, b.parsed.subLabels) || a.tab.index - b.tab.index);
    const tabIds = site.entries.map((e) => e.tab.id);
    if (tabIds.length >= MIN_GROUP_SIZE) {
      const groupId = await ensureGroup(site, groups, managed, windowId);
      units.push({ groupId, tabIds });
    } else {
      const grouped = site.entries.filter((e) => e.tab.groupId !== NO_GROUP).map((e) => e.tab.id);
      if (grouped.length) await chrome.tabs.ungroup(grouped);
      for (const id of tabIds) units.push({ tabIds: [id] });
    }
  }
  await rememberGroups(managed);

  const pinnedCount = tabs.filter((t) => t.pinned).length;
  await arrange(windowId, units, pinnedCount);
}

async function ensureGroup(site, groups, managed, windowId) {
  const existing = groups.find((g) => managed.has(g.id) && g.title === site.siteLabel);
  if (existing) {
    const missing = site.entries.filter((e) => e.tab.groupId !== existing.id).map((e) => e.tab.id);
    if (missing.length) await chrome.tabs.group({ groupId: existing.id, tabIds: missing });
    return existing.id;
  }
  const tabIds = site.entries.map((e) => e.tab.id);
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: site.siteLabel, color: colorFor(site.site) });
  managed.add(groupId);
  return groupId;
}

/**
 * ピン留めタブの直後から、サイト順・サブドメイン順にタブとグループを並べる。
 * 左から順に確定させるので、移動はいつも左向きになる。それ以外のタブは右側に寄る。
 */
async function arrange(windowId, units, start) {
  let index = start;
  for (const { groupId, tabIds } of units) {
    if (groupId !== undefined) {
      const members = await chrome.tabs.query({ windowId, groupId });
      const groupStart = Math.min(...members.map((t) => t.index));
      if (groupStart !== index) await chrome.tabGroups.move(groupId, { index });
    }
    for (const [i, tabId] of tabIds.entries()) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.index !== index + i) await chrome.tabs.move(tabId, { index: index + i });
    }
    if (groupId !== undefined) {
      // 並べ替えの途中でグループから外れたタブを戻す
      const current = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
      const left = current.filter((t) => t.groupId !== groupId).map((t) => t.id);
      if (left.length) await chrome.tabs.group({ groupId, tabIds: left });
    }
    index += tabIds.length;
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
