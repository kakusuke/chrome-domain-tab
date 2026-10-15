// Public Suffix List のうち、よく使う多段サフィックスだけを抜き出したもの。
// ここにないサフィックスは最後の1ラベル（com、jp など）として扱う。
const MULTI_LABEL_SUFFIXES = new Set([
  // 日本
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp',
  // その他の国
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'co.kr', 'or.kr', 'com.cn', 'net.cn', 'org.cn', 'com.tw', 'org.tw',
  'com.hk', 'com.sg', 'com.br', 'co.in', 'co.id', 'co.th', 'com.mx',
  // サブドメインごとに別サイトになるホスティングサービス
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'web.app', 'firebaseapp.com', 'appspot.com', 'blogspot.com',
  'cloudfront.net', 'azurewebsites.net', 's3.amazonaws.com',
]);

const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/**
 * タブの URL をドメイン単位に分解する。http(s) 以外は null を返す。
 *
 * 例: https://api.v2.google.com/ →
 *   { host: 'api.v2.google.com', site: 'google.com', siteLabel: 'com.google', subLabels: ['v2', 'api'] }
 */
export function parseTabUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  // IP アドレスや localhost は逆順にしても意味がないので、そのまま1つのサイトとして扱う
  if (isIpAddress(host) || !host.includes('.')) {
    return { host, site: host, siteLabel: host, subLabels: [] };
  }

  const labels = host.split('.');
  let suffixLength = 1;
  for (let n = Math.min(3, labels.length - 1); n >= 2; n--) {
    if (MULTI_LABEL_SUFFIXES.has(labels.slice(-n).join('.'))) {
      suffixLength = n;
      break;
    }
  }
  const siteLength = Math.min(labels.length, suffixLength + 1);
  const siteLabels = labels.slice(-siteLength);
  return {
    host,
    site: siteLabels.join('.'),
    siteLabel: [...siteLabels].reverse().join('.'),
    subLabels: labels.slice(0, -siteLength).reverse(),
  };
}

function isIpAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':');
}

export function compareStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** サブドメインのラベル列を辞書順で比べる。親（短いほう）が先に来る。 */
export function compareLabels(a, b) {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const c = compareStr(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

/** 同じサイトには毎回同じ色を割り当てる。 */
export function colorFor(site) {
  let hash = 0;
  for (const ch of site) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

/**
 * タブを並べ替えの単位（ブロック）に分ける。分割ビューの2枚は離せないので1つのブロックにまとめる。
 * 分割ビューに入っていないタブは splitViewId が noSplit か undefined（Chrome 140 未満）。
 */
export function toBlocks(tabs, noSplit = -1) {
  const blocks = [];
  const splits = new Map();
  for (const tab of [...tabs].sort((a, b) => a.index - b.index)) {
    if (tab.splitViewId === undefined || tab.splitViewId === noSplit) {
      blocks.push([tab]);
      continue;
    }
    let block = splits.get(tab.splitViewId);
    if (!block) {
      splits.set(tab.splitViewId, block = []);
      blocks.push(block);
    }
    block.push(tab);
  }
  return blocks;
}
