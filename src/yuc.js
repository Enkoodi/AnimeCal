/**
 * yuc.wiki（長門番堂）新番表抓取模块
 * - 番剧总数以该页面为准（本季 + 下季，临近新季度时才发布下季）
 * - 提供星期、放送时间、总集数与「备选首播日」（Bangumi 不可用时按它往后推整季）
 * 真实播出日期仍以 Bangumi 为准。
 */

const YUC_BASE = 'https://yuc.wiki';
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

/** 抓取某季度页面 HTML；下季尚未发布（404/空）返回 null，网络错误则抛异常 */
export async function fetchSeasonHtml(year, month) {
  const url = `${YUC_BASE}/${seasonKey(year, month)}/`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text) return null;
  // 站点对不存在的季度返回 GitHub Pages 默认 404 页（可能仍是 200）
  if (/File not found|404/.test(text.slice(0, 800)) && !/div_date/.test(text)) return null;
  return text;
}

function matchWeekday(text) {
  const m = String(text).match(/(周[一二三四五六日天]|星期[一二三四五六日天])/);
  return m ? WEEKDAY_CN[m[1]] : null;
}

/** 由季度月 + 星期推导一个「备选首播日」（Bangumi 不可用时按此往后推整季） */
function deriveStartDate(year, seasonMonth, weekday, dateHint) {
  let y = year;
  let m = seasonMonth;
  let d = 1;
  const monthStart = new Date(year, seasonMonth - 1, 1);
  const firstWeekday = monthStart.getDay();
  d = 1 + ((weekday - firstWeekday + 7) % 7);
  if (dateHint) {
    // 页面里标注的具体日期，如 "8/12~"，与季度同年
    m = dateHint.month;
    d = dateHint.day;
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
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
    seasonLabel: `${year}年${pad2(seasonMonth)}月`,
  };
}

/**
 * 加载本季度（+ 下季度若已发布）番剧，按 weekday(0-6) 分组
 * @returns {Promise<{byWeekday: Record<number,Array>, total:number}>}
 */
export async function loadSeasonAnime(now = new Date()) {
  const year = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const qStart = quarterStartMonth(currentMonth);
  const nextMonth = qStart + 3;
  const seasons = [
    { year, month: qStart },
    { year: nextMonth > 12 ? year + 1 : year, month: nextMonth > 12 ? 1 : nextMonth },
  ];

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
      const arr = byWeekday[it.weekday] || (byWeekday[it.weekday] = []);
      arr.push(it);
      total++;
    }
  }
  return { byWeekday, total, errors };
}