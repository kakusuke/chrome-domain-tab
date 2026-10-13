import { parseTabUrl, compareStr } from './domain.js';

const COLLAPSED_KEY = 'collapsed';
const OTHERS_KEY = '__others';
const RENDER_DEBOUNCE_MS = 100;

const treeEl = document.getElementById('tree');
const summaryEl = document.getElementById('summary');
const collapsed = new Set(readCollapsed());
let windowId;
let timer;

function readCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) ?? [];
  } catch {
    return [];
  }
}

function writeCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // 保存できなくても表示には影響しない
  }
}

const newNode = (label, key) => ({ label, key, children: new Map(), tabs: [] });
const byLabel = (a, b) => compareStr(a.label, b.label);

/** 登録可能ドメイン（com.google）を根に、サブドメインを逆順にたどる木を作る。 */
function buildTree(tabs) {
  const roots = new Map();
  const others = newNode('その他', OTHERS_KEY);
  for (const tab of tabs) {
    const parsed = parseTabUrl(tab.pendingUrl || tab.url);
    if (!parsed) {
      others.tabs.push(tab);
      continue;
    }
    let node = roots.get(parsed.siteLabel);
    if (!node) roots.set(parsed.siteLabel, node = newNode(parsed.siteLabel, parsed.siteLabel));
    for (const label of parsed.subLabels) {
      let child = node.children.get(label);
      if (!child) node.children.set(label, child = newNode(label, `${node.key}/${label}`));
      node = child;
    }
    node.tabs.push(tab);
  }
  return { roots: [...roots.values()].sort(byLabel), others };
}

function countTabs(node) {
  let count = node.tabs.length;
  for (const child of node.children.values()) count += countTabs(child);
  return count;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderNode(node) {
  const details = el('details', 'node');
  details.open = !collapsed.has(node.key);
  details.addEventListener('toggle', () => {
    if (details.open) collapsed.delete(node.key);
    else collapsed.add(node.key);
    writeCollapsed();
  });

  const summary = el('summary');
  summary.append(el('span', 'label', node.label), el('span', 'count', String(countTabs(node))));

  const children = el('div', 'children');
  for (const child of [...node.children.values()].sort(byLabel)) children.append(renderNode(child));
  for (const tab of node.tabs.sort((a, b) => a.index - b.index)) children.append(renderTab(tab));

  details.append(summary, children);
  return details;
}

function renderTab(tab) {
  const url = tab.pendingUrl || tab.url || '';
  const row = el('div', tab.active ? 'tab active' : 'tab');
  row.title = url;
  row.addEventListener('click', () => chrome.tabs.update(tab.id, { active: true }));

  const icon = el('img', 'favicon');
  icon.alt = '';
  const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
  faviconUrl.searchParams.set('pageUrl', url);
  faviconUrl.searchParams.set('size', '32');
  icon.src = faviconUrl.href;

  const close = el('button', 'close', '×');
  close.type = 'button';
  close.title = 'タブを閉じる';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.tabs.remove(tab.id);
  });

  row.append(icon, el('span', 'title', tab.title || url), close);
  return row;
}

async function render() {
  const tabs = await chrome.tabs.query({ windowId });
  const { roots, others } = buildTree(tabs);
  const fragment = document.createDocumentFragment();
  for (const root of roots) fragment.append(renderNode(root));
  if (others.tabs.length) fragment.append(renderNode(others));
  treeEl.replaceChildren(fragment);
  summaryEl.textContent = `${roots.length} サイト · ${tabs.length} タブ`;
}

function scheduleRender() {
  clearTimeout(timer);
  timer = setTimeout(render, RENDER_DEBOUNCE_MS);
}

for (const event of [
  chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onMoved,
  chrome.tabs.onActivated, chrome.tabs.onAttached, chrome.tabs.onDetached,
]) {
  event.addListener(scheduleRender);
}

windowId = (await chrome.windows.getCurrent()).id;
render();
