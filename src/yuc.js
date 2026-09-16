/**
 * yuc.wiki（長門番堂）新番表抓取模块
 * - 番剧总数以该页面为准（本季 + 下季，临近新季度时才发布下季）
 * - 提供星期、放送时间、总集数与「备选首播日」（Bangumi 不可用时按它往后推整季）
 * 真实播出日期仍以 Bangumi 为准。
 */

const YUC_BASE = 'https://yuc.wiki';
/**
 * 备用协议。yuc.wiki 的 TLS 证书已于 2026-07-29 过期（TrustAsia DV，签发 2026-05-01，
 * 站点未自动续期），WebView2 / 系统证书校验会直接拒绝 https 请求
 * （ERR_CERT_DATE_INVALID / certificate has expired）。站点未强制跳转 https，
 * 故 https 失败时退回 http，保证新番列表仍能加载。
 * 需同步在 tauri.conf.json 的 CSP connect-src 中放行 http://yuc.wiki。
 */
const YUC_BASE_HTTP = 'http://yuc.wiki';
const WEEKDAY_CN = {
  周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 0,
  星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6, 星期天: 0,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 给出月份（1-12）所在季度的起始月（1/4/7/10） */
export function quarterStartMonth(month) {
  return Math.floor((month - 1) / 3) * 3 + 1;
}

export function seasonKey(year, month) {
  return `${year}${pad2(month)}`;
}

/** 用指定协议抓一次季度页；页面不存在返回 null，网络/证书错误抛异常 */
async function fetchSeasonHtmlOnce(base, year, month) {
  const url = `${base}/${seasonKey(year, month)}/`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text) return null;
  // 以「是否含番剧结构」判定页面是否有效：
  // 不存在的季度会返回 404 页（新版 Hexo 站可能仍返回 200）；
  // 旧版结构标记 .div_date，新版（2026-10 起）只剩 .title_main_r 介绍列表。
  if (!/div_date|title_main_r/.test(text)) return null;
  return text;
}

/** 抓取某季度页面 HTML；下季尚未发布（404/空）返回 null。
 *  先走 https，因 yuc.wiki 证书已过期会失败，此时自动退回 http。 */
export async function fetchSeasonHtml(year, month) {
  let firstErr = null;
  for (const base of [YUC_BASE, YUC_BASE_HTTP]) {
    try {
      return await fetchSeasonHtmlOnce(base, year, month);
    } catch (err) {
      if (!firstErr) firstErr = err;
    }
  }
  throw new Error(`${firstErr ? firstErr.message : '网络错误'}（https 与 http 均失败）`);
}

function matchWeekday(text) {
  const m = String(text).match(/(周[一二三四五六日天]|星期[一二三四五六日天])/);
  return m ? WEEKDAY_CN[m[1]] : null;
}

/** 由季度月 + 星期推导一个「备选首播日」（Bangumi 不可用时按此往后推整季）
 *  weekday 为 null（网络放送等无固定星期）且无具体日期时返回 null */
function deriveStartDate(year, seasonMonth, weekday, dateHint) {
  if (dateHint) {
    // 页面里标注的具体日期，如 "8/12~"。
    // 跨年修正：10 月页会标注次年 1 月的日期，1 月页会标注上一年 12 月的日期。
    let y = year;
    if (seasonMonth >= 10 && dateHint.month <= 3) y = year + 1;
    else if (seasonMonth <= 3 && dateHint.month >= 10) y = year - 1;
    return `${y}-${pad2(dateHint.month)}-${pad2(dateHint.day)}`;
  }
  if (weekday == null) return null;
  const monthStart = new Date(year, seasonMonth - 1, 1);
  const firstWeekday = monthStart.getDay();
  const d = 1 + ((weekday - firstWeekday + 7) % 7);
  return `${year}-${pad2(seasonMonth)}-${pad2(d)}`;
}

/**
 * 解析页面下方「新番介绍部分」的详细列表，得到每部的原名（title_jp_r）、
 * 译名（title_cn_r）与参与员工（staff_r / cast_r），按封面图 URL 建索引。
 * 周更表格里只有中文译名，原名只在详细列表里标注，借此给周更条目补上原名。
 */
function parseDetailList(doc) {
  const map = new Map();
  const jpEls = doc.querySelectorAll('[class*="title_jp_r"]');
  for (const jp of jpEls) {
    const originalName = (jp.textContent || '').replace(/\s+/g, ' ').trim();
    if (!originalName) continue;
    const table = jp.closest('table');
    if (!table) continue;
    const cnEl = table.querySelector('[class*="title_cn_r"]');
    const staffEl = table.querySelector('.staff_r');
    const castEl = table.querySelector('.cast_r');
    // 下方详细列表里标注的具体首播日期，如 "8/12周三晚间"
    const broadcastEl = table.querySelector('.broadcast_r');
    let airDate = null;
    if (broadcastEl) {
      const dm = (broadcastEl.textContent || '').match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
      if (dm) airDate = { month: Number(dm[1]), day: Number(dm[2]) };
    }
    let cover = '';
    // 结构：<div style="float:left"><img …></div><div><table>…</table></div>
    const holder = table.parentElement;
    const imgHolder = holder ? holder.previousElementSibling : null;
    if (imgHolder) {
      const img = imgHolder.querySelector('img');
      if (img) cover = img.getAttribute('data-src') || img.getAttribute('src') || '';
    }
    map.set(cover, {
      originalName,
      name_cn: cnEl ? (cnEl.textContent || '').replace(/\s+/g, ' ').trim() : '',
      staff: staffEl ? (staffEl.textContent || '').replace(/\s+/g, ' ').trim() : '',
      cast: castEl ? (castEl.textContent || '').replace(/\s+/g, ' ').trim() : '',
      airDate,
    });
  }
  return map;
}

/**
 * 解析季度页 HTML 为番剧列表
 * @returns {Array<{name, weekday, airTime, totalEpisodes, cover, yucStartDate, seasonLabel, originalName}>}
 */
export function parseSeasonHtml(html, year, seasonMonth) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 旧版页面（2026-07 及以前）：按星期分栏的周更表格，信息更全（含集数与具体时刻）
  if (doc.querySelector('.div_date')) {
    const items = parseWeekdayTable(doc, year, seasonMonth);
    if (items.length) return items;
  }
  // 新版页面（2026-10 起）：周更表格已被移除，只剩「新番介绍」扁平列表
  return parseFlatList(doc, year, seasonMonth);
}

/** 旧版结构：解析「按星期分栏」的周更表格（div_date / date2 / date_title） */
function parseWeekdayTable(doc, year, seasonMonth) {
  const detailMap = parseDetailList(doc);
  const items = [];
  let weekday = null;

  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls.split(/\s+/).includes('date2')) {
      const wk = matchWeekday(el.textContent || '');
      if (wk != null) weekday = wk;
      continue;
    }
    // 番剧块：包含 .div_date 且以 float 左排的容器（div_date 的直接父即该块）
    if (el.classList && el.classList.contains('div_date')) {
      if (weekday == null) continue;
      const block = el.parentElement;
      if (!block) continue;
      const item = parseAnimeBlock(block, weekday, year, seasonMonth);
      if (item) items.push(item);
    }
  }

  // 周更表格条目按封面图关联到详细列表，补上原名、具体播出日期等信息
  for (const item of items) {
    const detail = detailMap.get(item.cover);
    if (detail) {
      item.originalName = detail.originalName;
      item.staff = detail.staff;
      item.cast = detail.cast;
      // 详细列表标注的具体首播日期（broadcast_r）优先于「第一个星期几」推算
      if (detail.airDate) {
        item.yucStartDate = deriveStartDate(year, seasonMonth, item.weekday, detail.airDate);
        item.hasRealDate = true;
      }
    }
  }
  return items;
}

function parseAnimeBlock(block, weekday, year, seasonMonth) {
  const divDate = block.querySelector('.div_date');
  let airTime = '';
  let totalEpisodes = null;
  let cover = '';
  let dateHint = null;

  if (divDate) {
    const tEl = divDate.querySelector('.imgtext4');
    if (tEl) {
      const m = tEl.textContent.trim().match(/([01]?\d):(\d{2})/);
      if (m) airTime = `${m[1].padStart(2, '0')}:${m[2]}`;
    }
    // 集数：形如 (全13话)，常见于 .imgep
    const epEl = divDate.querySelector('.imgep');
    if (epEl) {
      const t = epEl.textContent.trim();
      const totalMatch = t.match(/全\s*(\d{1,3})\s*话/);
      if (totalMatch) totalEpisodes = Number(totalMatch[1]);
    }
    // 首播日期：形如 8/12~，常见于 .imgep2（部分番剧无集数只有日期）；也兼容 .imgep 中的日期
    const dateEl = divDate.querySelector('.imgep2') || divDate.querySelector('.imgep');
    if (dateEl) {
      const t = dateEl.textContent.trim();
      const dm = t.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
      if (dm) dateHint = { month: Number(dm[1]), day: Number(dm[2]) };
    }
    const img = divDate.querySelector('img');
    if (img) cover = img.getAttribute('data-src') || img.getAttribute('src') || '';
  }

  const titleTd = block.querySelector('td[class*="date_title"]');
  const name = titleTd ? titleTd.textContent.replace(/\s+/g, ' ').trim() : '';
  if (!name) return null;

  return {
    key: name,
    name,
    weekday,
    airTime,
    totalEpisodes,
    cover,
    yucStartDate: deriveStartDate(year, seasonMonth, weekday, dateHint),
    hasRealDate: dateHint != null,
    seasonKey: seasonKey(year, seasonMonth),
    seasonLabel: `${year}年${pad2(seasonMonth)}月`,
  };
}

/** 取元素文本并压平空白；<br> 视为折行（转空格）避免标题粘连，元素不存在返回空串 */
function textOf(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => br.replaceWith(' '));
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

/** 条目封面：<div style="float:left"><img data-src></div> 是表格容器的前一个兄弟节点 */
function coverOfTable(table) {
  const holder = table.parentElement;
  const imgHolder = holder ? holder.previousElementSibling : null;
  const img = imgHolder ? imgHolder.querySelector('img') : null;
  return img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
}

/**
 * 解析新版条目的播出标注，如 "10/3周六深夜"、"9/25网络放送"、"周二深夜"。
 * 新版页面不再给出具体时刻（旧版 .imgtext4 才有）与总集数，故只取日期与星期。
 */
function parseBroadcast(text) {
  const t = String(text || '');
  const dm = t.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  return {
    raw: t,
    weekday: matchWeekday(t),
    date: dm ? { month: Number(dm[1]), day: Number(dm[2]) } : null,
  };
}

/**
 * 新版结构（2026-10 起）：页面只保留「新番介绍」扁平列表，旧的周更表格
 * （.date2 星期表头 / .div_date 番剧块）已全部移除，因此按 td.title_main_r
 * 逐条解析，星期与首播日从条目的 .broadcast_r 文本中取。
 */
function parseFlatList(doc, year, seasonMonth) {
  const items = [];
  const keyCount = new Map();

  for (const cell of doc.querySelectorAll('td[class*="title_main_r"]')) {
    const table = cell.closest('table');
    if (!table) continue;
    // 标题类名带序号后缀（title_cn_r / title_cn_r1 / title_jp_r2 …），用前缀匹配
    const name = textOf(table.querySelector('[class*="title_cn_r"]'));
    const originalName = textOf(table.querySelector('[class*="title_jp_r"]'));
    const title = name || originalName;
    if (!title) continue;

    // 同名条目（跨季重播等）加序号，避免 data-key 冲突
    const dup = keyCount.get(title) || 0;
    keyCount.set(title, dup + 1);
    const key = dup ? `${title} (${dup + 1})` : title;

    const bc = parseBroadcast(textOf(table.querySelector('.broadcast_r')));
    items.push({
      key,
      name: title,
      originalName,
      weekday: bc.weekday, // 网络放送等无固定星期，为 null
      airTime: '', // 新版页面不再给出具体时刻，交由 Bangumi 补全
      totalEpisodes: null, // 新版页面不再给出集数，交由 Bangumi 补全
      cover: coverOfTable(table),
      broadcastRaw: bc.raw,
      yucStartDate: deriveStartDate(year, seasonMonth, bc.weekday, bc.date),
      hasRealDate: bc.date != null,
      staff: textOf(table.querySelector('[class*="staff_r"]')),
      cast: textOf(table.querySelector('[class*="cast_r"]')),
      seasonKey: seasonKey(year, seasonMonth),
      seasonLabel: `${year}年${pad2(seasonMonth)}月`,
    });
  }
  return items;
}

/**
 * 当前应展示的季度：本季 + 下季。
 * yuc.wiki 会在下季开播前提前发布页面，那段时间两季都展示；
 * 下季开始后「本季」自动前移，于是只剩新一季（下下季通常尚未发布 → 返回 null 被跳过）。
 */
function seasonPairs(now = new Date()) {
  const year = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const qStart = quarterStartMonth(currentMonth);
  const nextMonth = qStart + 3;
  return [
    { year, month: qStart },
    { year: nextMonth > 12 ? year + 1 : year, month: nextMonth > 12 ? 1 : nextMonth },
  ];
}

/** 当前应展示的季度键，如 ['202607','202610']；供缓存判断是否跨季失效 */
export function currentSeasonKeys(now = new Date()) {
  return seasonPairs(now).map(s => seasonKey(s.year, s.month));
}

/**
 * 加载本季度（+ 下季度若已发布）番剧，按 weekday(0-6) 分组
 * @returns {Promise<{byWeekday: Record<number,Array>, total:number}>}
 */
export async function loadSeasonAnime(now = new Date()) {
  const seasons = seasonPairs(now);

  const byWeekday = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  let total = 0;
  const errors = [];

  for (const { year: y, month: m } of seasons) {
    let html;
    try {
      html = await fetchSeasonHtml(y, m);
    } catch (e) {
      errors.push(`${seasonKey(y, m)} 抓取失败(${e.message})`);
      continue;
    }
    if (!html) continue;
    const list = parseSeasonHtml(html, y, m);
    for (const it of list) {
      // weekday 为 null（网络放送等无固定档期）时归入 unknown 桶，仍参与渲染与统计
      const bucket = it.weekday == null ? 'unknown' : it.weekday;
      const arr = byWeekday[bucket] || (byWeekday[bucket] = []);
      arr.push(it);
      total++;
    }
  }
  return { byWeekday, total, errors };
}