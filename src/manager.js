/**
 * 管理番剧独立窗口
 */
import * as AnimeStore from './anime.js';
import * as BangumiAPI from './bangumi.js';
import * as YucAPI from './yuc.js';
import * as Cache from './cache.js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

let bangumiSeasonResults = {};
let seasonTotal = 0;
let seasonFilter = { weekday: 'all', name: '' };
let ratingSel = [];
let enrichInProgress = false;
let thumbImgEls = new Map();

function showToast(message, duration = 2200) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), duration);
}

async function notifyMainWindow() {
  try {
    await invoke('notify_all_windows');
  } catch (err) {
    console.warn('notify_all_windows failed', err);
  }
  // 保留 storage 事件作为兜底（不同窗口 localStorage 路径一致时也能触发刷新）
  try {
    localStorage.setItem('anime_cal_ping', String(Date.now()));
  } catch {
    /* ignore */
  }
}

function markBangumiItemSelected(el, selected) {
  el.classList.toggle('selected', selected);
  const mark = el.querySelector('.added-mark');
  if (selected) {
    if (!mark) el.insertAdjacentHTML('beforeend', '<span class="added-mark">✓</span>');
  } else if (mark) {
    mark.remove();
  }
}

/**
 * 剥掉名称尾部的「分段标识」（如 P2 / Part.2 / Part 2）。
 * Bangumi 搜索接口遇到这类后缀会直接 404（例如「Re:从零开始的异世界生活 第4期 P2」），
 * 因此先去掉再搜，再用首播日期 / 集数在候选中区分具体是哪一部。
 */
function stripSegmentMarker(name) {
  return String(name || '')
    .replace(/\s*\b(?:Part\.?|P)\s*\d+\s*$/i, '')
    .trim();
}

/** 由完整名到逐步精简，生成去重保序的搜索关键词 */
function buildSearchKeywords(name) {
  const out = [];
  const seen = new Set();
  let cur = String(name || '').trim();
  const push = (s) => { if (s && !seen.has(s)) { seen.add(s); out.push(s); } };
  push(cur);
  for (let i = 0; i < 4; i++) {
    const next = stripSegmentMarker(cur);
    if (!next || next === cur) break;
    push(next);
    cur = next;
  }
  return out;
}

/** 名称规范化：忽略大小写/空白/全半角冒号与常见标点，用于「是否已追」的容错匹配 */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s:：·・.．,，/／\-—–_（）()【】[\]《》「」『』]/g, '')
    .trim();
}

/** 统一取番剧身份 id：季度列表项用 bangumiId，搜索结果项用 id */
function bangumiIdOf(item) {
  const v = item.bangumiId != null ? item.bangumiId : item.id;
  return v != null ? String(v) : null;
}

/** 收集一个条目所有可比较的名称变体（中/日/原名 + 去掉 P2、Part.2 等分段标识） */
function itemNameVariants(item) {
  const set = new Set();
  for (const raw of [item.name, item.name_cn, item.originalName]) {
    if (!raw) continue;
    for (const kw of buildSearchKeywords(raw)) set.add(normalizeName(kw));
  }
  return set;
}

/**
 * 判断某个季度/搜索条目是否已在关注列表，返回命中的关注记录或 null。
 * 「已添加」显示与「点击取消/添加」共用此判定，避免两处逻辑不一致。
 */
function matchMyAnime(item, myAnimeList) {
  const idKey = bangumiIdOf(item);
  const variants = itemNameVariants(item);
  return myAnimeList.find(a => {
    if (idKey && a.bangumiId != null && String(a.bangumiId) === idKey) return true;
    for (const an of buildSearchKeywords(a.name)) {
      if (variants.has(normalizeName(an))) return true;
    }
    return false;
  }) || null;
}

/**
 * 从 Bangumi 搜索结果中挑出与 yuc 条目最匹配的一个。
 * 仅凭名称取第一条容易错配同系列不同分段（如「丧失篇/P1」vs「夺还篇/P2」），
 * 故用 yuc 的「总集数 + 首播日期」作为对齐信号，从候选中选综合最接近者。
 */
async function findBestBangumiMatch(item) {
  const targetEps = item.totalEpisodes != null ? Number(item.totalEpisodes) : null;
  const targetDateMs = item.hasRealDate && item.yucStartDate
    ? (() => { const d = new Date(item.yucStartDate + 'T00:00:00'); return Number.isNaN(d.getTime()) ? null : d.getTime(); })()
    : null;

  // 名称匹配分两步：先按「原名」（日语原名，Bangumi 命中更准）搜，
  // 原名搜不到再退回到「译名」（yuc 的中文名）。完整名可能 404，均退化去掉 P2/Part.2 再试。
  const nameQueries = [];
  for (const kw of buildSearchKeywords(item.originalName || '')) {
    if (!nameQueries.includes(kw)) nameQueries.push(kw);
  }
  for (const kw of buildSearchKeywords(item.name)) {
    if (!nameQueries.includes(kw)) nameQueries.push(kw);
  }

  let hits = [];
  for (const kw of nameQueries) {
    try {
      const found = await BangumiAPI.searchBangumi(kw, { large: true, maxResults: 8 });
      if (found && found.length) { hits = found; break; }
    } catch {
      /* 404 / 网络失败 → 换下一个关键词 */
    }
  }
  if (!hits.length) return null;

  const withMeta = (h, eps = null, start = null) =>
    ({ ...h, eps: eps ?? h.eps ?? null, start_date: start || h.air_date || null });

  // 无任何对齐信号，或只有一个候选：取第一条（旧行为）
  if ((!targetEps && !targetDateMs) || hits.length === 1) return withMeta(hits[0]);

  let best = hits[0];
  let bestScore = Infinity;
  for (const hit of hits) {
    let eps = hit.eps ?? null;
    let startDate = hit.air_date || null;
    // 「large」搜索通常已带 eps / air_date；缺失时才补一次摘要
    if ((eps == null && targetEps != null) || (!startDate && targetDateMs)) {
      try {
        const brief = await BangumiAPI.getSubjectBrief(hit.id);
        eps = eps ?? brief.eps ?? null;
        startDate = startDate || brief.start_date || null;
      } catch {
        /* 摘要失败忽略 */
      }
    }
    // 集数差（权重高）+ 日期差（天数），选综合最小者
    let score = 0;
    if (targetEps != null && eps != null) {
      score += Math.abs(Number(eps) - targetEps) * 1000;
    }
    if (targetDateMs && startDate) {
      const bd = new Date(startDate + 'T00:00:00');
      if (!Number.isNaN(bd.getTime())) {
        score += Math.abs(bd.getTime() - targetDateMs) / 86400000;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = withMeta(hit, eps, startDate);
    }
  }
  return best;
}

async function toggleOrAddSeasonItem(el, item) {
  const existing = matchMyAnime(item, AnimeStore.getMyAnime());
  if (existing) {
    const removed = existing.bangumiId
      ? AnimeStore.removeMyAnimeByBangumiId(existing.bangumiId)
      : AnimeStore.removeMyAnimeByName(existing.name);
    if (removed && removed.success) {
      showToast('已取消关注');
      markBangumiItemSelected(el, false);
      await notifyMainWindow();
    }
    return;
  }

  el.style.opacity = '0.5';
  try {
    let payload;
    try {
      showToast('正在匹配播出日期...');
      let idForMatch = item.id || item.bangumiId || null;
      let detail;
      if (idForMatch) {
        detail = await BangumiAPI.getSubjectDetail(idForMatch);
      } else {
        const best = await findBestBangumiMatch(item);
        if (!best) throw new Error('bangumi-no-match');
        idForMatch = best.id;
        detail = await BangumiAPI.getSubjectDetail(best.id);
      }
      payload = {
        ...item,
        id: idForMatch,
        name: detail.name || item.name,
        name_cn: detail.name_cn || item.name,
        weekday: detail.weekday ?? item.weekday,
        air_time: detail.air_time || item.airTime || '',
        start_date: detail.start_date || detail.air_date || item.yucStartDate,
        end_date: detail.end_date || null,
        eps: detail.eps || detail.total_episodes || item.totalEpisodes,
        total_episodes: detail.eps || detail.total_episodes || item.totalEpisodes,
        episode_dates: detail.episode_dates,
        image: detail.image || item.cover,
        images: detail.images || item.images || { common: item.cover },
        rating: detail.rating,
      };
    } catch {
      // 连不上 Bangumi：用页面（星期 + 时间 + 集数 + 备选首播日）直接推算
      showToast('未能连接 Bangumi，改用页面日期推算');
      payload = {
        ...item,
        id: null,
        name: item.name_cn || item.name,
        name_cn: item.name_cn || item.name,
        air_time: item.airTime || '',
        start_date: item.yucStartDate || item.air_date || null,
        end_date: null,
        episode_dates: null,
        image: item.cover || item.image || '',
        images: { common: item.cover || item.image || '' },
      };
    }
    const result = AnimeStore.importFromBangumi(payload);
    showToast(result.message || '已添加');
    if (result.success) {
      // 写回匹配到的 bangumiId / 中文名，让下一次点击能立刻识别为「已添加」直接走取消
      if (payload.id != null) item.bangumiId = payload.id;
      if (payload.name_cn) item.name_cn = payload.name_cn;
      markBangumiItemSelected(el, true);
      const { keepKeys } = Cache.writeSeasonCache(bangumiSeasonResults, seasonTotal);
      Cache.pruneThumbs(keepKeys);
      await notifyMainWindow();
    }
  } catch (err) {
    console.error('添加失败', err);
    showToast('添加失败，请稍后重试');
  }
  el.style.opacity = '1';
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

function initSeasonFilters() {
  document.querySelectorAll('#weekday-filters .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#weekday-filters .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      seasonFilter.weekday = chip.dataset.weekday;
      renderBangumiSeason();
    });
  });
  document.querySelectorAll('#rating-scale .rating-num').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt(btn.dataset.rating, 10);
      const idx = ratingSel.indexOf(v);
      if (idx !== -1) {
        ratingSel.splice(idx, 1);
      } else {
        if (ratingSel.length >= 2) ratingSel.shift();
        ratingSel.push(v);
      }
      updateRatingScaleUI();
      renderBangumiSeason();
    });
  });
  updateRatingScaleUI();
  document.getElementById('name-filter').addEventListener('input', (e) => {
    seasonFilter.name = e.target.value.trim().toLowerCase();
    renderBangumiSeason();
  });
}

async function loadSeason(forceRefresh = false) {
  const container = document.getElementById('bangumi-season');

  // 先读本地缓存：有且未过期则直接渲染，打开更快、离线也能用
  if (!forceRefresh) {
    const cached = Cache.readSeasonCache();
    if (cached && Cache.isCacheFresh(cached)) {
      bangumiSeasonResults = cached.byWeekday || {};
      seasonTotal = cached.total || 0;
      if (seasonTotal > 0) {
        renderBangumiSeason();
        loadThumbnails();
        return;
      }
    }
  }

  container.innerHTML = '<div class="loading"><div class="spinner"></div>正在获取番剧信息...</div>';
  try {
    const { byWeekday, total, errors } = await YucAPI.loadSeasonAnime();
    bangumiSeasonResults = byWeekday;
    seasonTotal = total;
    AnimeStore.setLastFetch();
    if (total > 0) {
      renderBangumiSeason();
      const { keepKeys } = Cache.writeSeasonCache(byWeekday, total);
      Cache.pruneThumbs(keepKeys);
      loadThumbnails();
      enrichSeasonInfo();
    } else if (errors.length) {
      container.innerHTML = `<div class="loading">加载失败: ${errors.join('；')}</div>`;
    } else {
      container.innerHTML = '<div class="loading">暂无本季/下季番剧数据（下季临近新季度才发布）</div>';
    }
  } catch (error) {
    container.innerHTML = `<div class="loading">加载失败: ${error.message}，可点右上角「刷新列表」重试</div>`;
  }
}

/** 简易并发池：按固定并发度依次消费 items */
async function runPool(items, worker, concurrency) {
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
    }
  }
  const runners = [];
  const count = Math.min(concurrency, items.length);
  for (let k = 0; k < count; k++) runners.push(runner());
  await Promise.all(runners);
}

/** 把 'YYYY-MM-DD' 精简为 'M月D日' */
function formatShortDate(ymd) {
  const m = String(ymd || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return String(ymd || '');
  return `${Number(m[2])}月${Number(m[3])}日`;
}

/** 把封面图缩小为缩略图 dataURL（最长边 160px，JPEG），控制缓存体积 */
function downscaleToThumb(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 160;
        const w0 = img.naturalWidth || MAX;
        const h0 = img.naturalHeight || MAX;
        const scale = Math.min(1, MAX / w0);
        const w = Math.max(1, Math.round(w0 * scale));
        const h = Math.max(1, Math.round(h0 * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      } catch {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/** 加载单条封面的缩略图：先读 IndexedDB，缺失才拉取 + 缩小 + 存回 */
async function loadThumbToItem(item) {
  if (!item.cover || item.__thumbDone) return;
  item.__thumbDone = true;
  let thumb = await Cache.getThumb(item.cover);
  if (thumb) {
    item.thumb = thumb;
    const imgEl = thumbImgEls.get(item.key);
    if (imgEl) imgEl.src = thumb;
    return;
  }
  try {
    // hdslb 图床有 Referer 防盗链，带上会 403；必须显式去掉 Referer
    const res = await fetch(item.cover, { cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!res.ok) return;
    const blob = await res.blob();
    thumb = await downscaleToThumb(blob);
    if (thumb) {
      item.thumb = thumb;
      const imgEl = thumbImgEls.get(item.key);
      if (imgEl) imgEl.src = thumb;
      await Cache.saveThumb(item.cover, thumb);
    }
  } catch {
    /* 拉取失败则保留远程原图 */
  }
}

/** 后台并发加载所有条目的缩略图（不阻塞列表渲染） */
async function loadThumbnails() {
  const items = [];
  for (const w in bangumiSeasonResults) {
    for (const it of bangumiSeasonResults[w]) items.push(it);
  }
  runPool(items, loadThumbToItem, 6);
}

/**
 * 后台为季度列表从 Bangumi 补全真实信息（首播日期、总集数、评分、bangumiId）。
 * 条目总数仍以 yuc.wiki 为准；此处只做逐条信息补全，Bangumi 连不上时保留 yuc 备用值。
 */
async function enrichSeasonInfo() {
  if (enrichInProgress) return;
  const items = [];
  for (const w in bangumiSeasonResults) {
    for (const it of bangumiSeasonResults[w]) items.push(it);
  }
  const need = items.filter(it => !it.__enriched);
  if (!need.length) return;

  enrichInProgress = true;
  let updated = 0;
  try {
    await runPool(need, async (item) => {
      try {
        const best = await findBestBangumiMatch(item);
        if (!best || !best.id) return;
        item.bangumiId = best.id;
        item.__enriched = true;
        if (best.rating != null) item.rating = best.rating;
        if (best.name_cn && !item.name_cn) item.name_cn = best.name_cn;
        let eps = best.eps ?? null;
        let startDate = best.start_date ?? null;
        if (eps == null || startDate == null) {
          try {
            const brief = await BangumiAPI.getSubjectBrief(best.id);
            eps = eps ?? brief.eps ?? null;
            startDate = startDate ?? brief.start_date ?? null;
          } catch {
            /* 摘要失败忽略 */
          }
        }
        // bangumi 数据优先：真实集数与首播日覆盖 yuc 的未知/默认值
        if (eps != null) item.totalEpisodes = eps;
        if (startDate) item.startDate = startDate;
        updated++;
      } catch {
        /* 单条失败忽略 */
      }
    }, 4);
  } finally {
    enrichInProgress = false;
  }
  if (updated > 0) {
    renderBangumiSeason();
    const { keepKeys } = Cache.writeSeasonCache(bangumiSeasonResults, seasonTotal);
    Cache.pruneThumbs(keepKeys);
  }
}

function updateRatingScaleUI() {
  const sorted = [...ratingSel].sort((a, b) => a - b);
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  document.querySelectorAll('#rating-scale .rating-num').forEach(btn => {
    const v = parseInt(btn.dataset.rating, 10);
    btn.classList.remove('selected', 'in-range');
    if (ratingSel.includes(v)) {
      btn.classList.add('selected');
    } else if (ratingSel.length === 2 && v > lo && v < hi) {
      btn.classList.add('in-range');
    }
  });
}

function getFilteredSeasonItems() {
  const allItems = [];
  for (const weekday in bangumiSeasonResults) {
    for (const item of bangumiSeasonResults[weekday]) allItems.push(item);
  }
  return allItems.filter(item => {
    if (seasonFilter.weekday !== 'all' && String(item.weekday) !== String(seasonFilter.weekday)) {
      return false;
    }
    if (ratingSel.length) {
      const sorted = [...ratingSel].sort((a, b) => a - b);
      const lo = sorted[0];
      const hi = sorted[sorted.length - 1] + 1;
      if (item.rating == null || item.rating < lo || item.rating >= hi) {
        return false;
      }
    }
    if (seasonFilter.name) {
      const hay = `${item.name_cn || ''} ${item.name || ''}`.toLowerCase();
      if (!hay.includes(seasonFilter.name)) return false;
    }
    return true;
  });
}

function findSeasonItem(key) {
  for (const weekday in bangumiSeasonResults) {
    const found = bangumiSeasonResults[weekday].find(i => i.key === key);
    if (found) return found;
  }
  return null;
}

function renderBangumiSeason() {
  const container = document.getElementById('bangumi-season');
  const items = getFilteredSeasonItems();

  if (seasonTotal === 0) {
    container.innerHTML = '<div class="loading">暂无所属季度番剧数据（可能已换季），可点右上角刷新</div>';
    return;
  }
  if (items.length === 0) {
    container.innerHTML = '<div class="loading">没有符合筛选条件的番剧</div>';
    return;
  }

  const myAnime = AnimeStore.getMyAnime();
  const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  container.innerHTML = `<div class="selection-bar"><span>显示 ${items.length} / ${seasonTotal} 部</span></div>` +
    items.map(item => {
      const alreadyAdded = !!matchMyAnime(item, myAnime);
      const startLabel = item.startDate
        ? formatShortDate(item.startDate)
        : (item.yucStartDate ? formatShortDate(item.yucStartDate) : (item.seasonLabel || ''));
      const meta = [
        weekdayNames[item.weekday % 7],
        startLabel,
        item.airTime || '',
        item.totalEpisodes ? `全${item.totalEpisodes}话` : '',
      ].filter(Boolean).join(' · ');
      const coverSrc = item.thumb || item.cover || '';
      return `<div class="bangumi-item ${alreadyAdded ? 'selected' : ''}" data-key="${item.key}">
        <img src="${coverSrc}" alt="${item.name}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'" onload="this.style.display=''"/>
        <div class="bangumi-item-info">
          <div class="bangumi-item-title">${item.name}</div>
          <div class="bangumi-item-meta">${meta}</div>
        </div>
        ${alreadyAdded ? '<span class="added-mark">✓</span>' : ''}
        ${item.rating != null ? `<span class="rating-badge">★${item.rating}</span>` : '<span class="rating-badge rating-pending">--</span>'}
      </div>`;
    }).join('');

  thumbImgEls.clear();
  container.querySelectorAll('.bangumi-item').forEach(el => {
    const img = el.querySelector('img');
    if (img) thumbImgEls.set(el.dataset.key, img);
    el.addEventListener('click', async () => {
      const item = findSeasonItem(el.dataset.key);
      if (!item) return;
      await toggleOrAddSeasonItem(el, item);
    });
  });
}

function initBangumiSearch() {
  document.getElementById('btn-search-bangumi').addEventListener('click', performSearch);
  document.getElementById('bangumi-search').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') performSearch();
  });

  async function performSearch() {
    const keyword = document.getElementById('bangumi-search').value.trim();
    if (!keyword) return;
    const container = document.getElementById('bangumi-results');
    container.innerHTML = '<div class="loading"><div class="spinner"></div>搜索中...</div>';
    try {
      const results = await BangumiAPI.searchBangumi(keyword);
      if (results.length === 0) {
        container.innerHTML = '<div class="loading">未找到相关番剧</div>';
        return;
      }
      const myAnimeIds = new Set(AnimeStore.getMyAnime().map(a => a.bangumiId).filter(Boolean));
      container.innerHTML = results.map(item =>
        `<div class="bangumi-item ${myAnimeIds.has(item.id) ? 'selected' : ''}" data-id="${item.id}">
          <img src="${item.image}" alt="${item.name_cn}" onerror="this.style.display='none'"/>
          <div class="bangumi-item-info">
            <div class="bangumi-item-title">${item.name_cn}</div>
            <div class="bangumi-item-meta">${item.air_date || '未知日期'}</div>
          </div>
          ${myAnimeIds.has(item.id) ? '<span class="added-mark">✓</span>' : ''}
        </div>`
      ).join('');

      container.querySelectorAll('.bangumi-item').forEach(el => {
        el.addEventListener('click', async () => {
          const id = parseInt(el.dataset.id, 10);
          const searchItem = results.find(i => i.id === id);
          if (!searchItem) return;
          await toggleOrAddSeasonItem(el, searchItem);
        });
      });
    } catch (error) {
      container.innerHTML = `<div class="loading">搜索失败: ${error.message}</div>`;
    }
  }
}

function initManualAdd() {
  document.getElementById('btn-save-manual').addEventListener('click', async () => {
    const name = document.getElementById('manual-name').value.trim();
    const weekday = parseInt(document.getElementById('manual-weekday').value, 10);
    const airTime = document.getElementById('manual-time').value;
    const startDate = document.getElementById('manual-start').value || null;
    const endDate = document.getElementById('manual-end').value || null;
    const epsRaw = document.getElementById('manual-eps').value;
    const totalEpisodes = epsRaw ? parseInt(epsRaw, 10) : null;
    const cover = document.getElementById('manual-cover').value.trim();
    if (!name) {
      showToast('请输入番剧名称');
      return;
    }
    if (!startDate) {
      showToast('请填写首播日期');
      return;
    }
    const result = AnimeStore.addMyAnime({
      name, weekday, airTime, cover, startDate, endDate, totalEpisodes,
    });
    showToast(result.message);
    if (result.success) {
      document.getElementById('manual-name').value = '';
      document.getElementById('manual-cover').value = '';
      document.getElementById('manual-start').value = '';
      document.getElementById('manual-end').value = '';
      document.getElementById('manual-eps').value = '';
      await notifyMainWindow();
      renderBangumiSeason();
    }
  });
}

async function closeManagerWindow() {
  try {
    await getCurrentWindow().close();
    return;
  } catch (err) {
    console.warn('close manager via tauri failed', err);
  }
  // 兜底：避免 window.close() 仅白屏，改用 hide
  try {
    await getCurrentWindow().hide();
  } catch (err2) {
    console.warn('hide manager via tauri failed', err2);
  }
}

async function listenExternalUpdates() {
  try {
    await window.__TAURI__?.event?.listen?.('anime-data-changed', () => {
      renderBangumiSeason();
    });
  } catch (err) {
    console.warn('manager listen anime-data-changed failed', err);
  }
  window.addEventListener('storage', (e) => {
    if (e.key === 'anime_cal_ping' || e.key === 'anime_cal_data') {
      renderBangumiSeason();
    }
  });
}

function init() {
  initTabs();
  initSeasonFilters();
  initBangumiSearch();
  initManualAdd();
  document.getElementById('btn-close-manager').addEventListener('click', closeManagerWindow);
  document.getElementById('btn-refresh-season').addEventListener('click', () => {
    showToast('正在刷新季度列表...');
    loadSeason(true);
  });
  loadSeason();
  listenExternalUpdates();
}

document.addEventListener('DOMContentLoaded', init);
