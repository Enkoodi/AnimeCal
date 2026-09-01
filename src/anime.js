/**
 * 番剧数据管理模块
 * 支持播出区间、单日多集覆盖，并按覆盖重算前后集数与完结日
 */

const STORAGE_KEY = 'anime_cal_data';
const DEFAULT_EPISODES = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

function toHttps(url) {
  if (!url || typeof url !== 'string') return '';
  let u = url.trim();
  if (u.startsWith('//')) u = `https:${u}`;
  if (u.startsWith('http://')) u = `https://${u.slice(7)}`;
  return u;
}

function toHalfWidth(s) {
  return s
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

export function parseDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  // 全角数字/分隔符先转半角，兼容 ２０２６／１／１４、2026．2．14 等写法
  const s = toHalfWidth(String(value).trim());
  const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function formatDateOnly(date) {
  if (!date) return '';
  const d = parseDateOnly(date);
  if (!d) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function addWeeks(date, weeks) {
  const d = parseDateOnly(date);
  if (!d) return null;
  d.setDate(d.getDate() + weeks * 7);
  return d;
}

export function computeEndDate(startDate, totalEpisodes) {
  const start = parseDateOnly(startDate);
  const eps = Number(totalEpisodes);
  if (!start || !eps || eps < 1) return null;
  return addWeeks(start, eps - 1);
}

export function formatEpisodeLabel(start, count = 1) {
  const s = Number(start);
  const c = Math.max(1, Number(count) || 1);
  if (!s) return '';
  if (c <= 1) return `第 ${s} 集`;
  return `第 ${s}-${s + c - 1} 集`;
}

function normalizeOverrides(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v) continue;
    const start = Number(v.start);
    const count = Math.max(1, Number(v.count) || 1);
    if (!start || start < 1) continue;
    out[k] = { start, count };
  }
  return out;
}

/**
 * 播出星期对应中文名，index 即 0-6（0=周日）
 */
export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 归一化「季中换周」记录：{date:'YYYY-MM-DD', weekday:0-6} 的数组，按日期升序、按日期去重
 */
function normalizeWeekdayShifts(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Map();
  for (const item of raw) {
    if (!item) continue;
    const date = formatDateOnly(item.date);
    if (!date) continue;
    let weekday = Number(item.weekday);
    if (weekday === 7) weekday = 0;
    if (Number.isNaN(weekday) || weekday < 0 || weekday > 6) continue;
    seen.set(date, weekday);
  }
  return Array.from(seen.entries())
    .map(([date, weekday]) => ({ date, weekday }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 归一化「每集真实放送日」：按集数顺序的数组，元素为 'YYYY-MM-DD' 或 null（未放送/未知）
 */
function normalizeEpisodeDates(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const d of raw) {
    if (d == null || d === '') { out.push(null); continue; }
    out.push(formatDateOnly(d) || null);
  }
  return out;
}

/**
 * 归一化「已看集数」：正整数升序去重数组（表示已看完的第几集）
 */
function normalizeWatchedEpisodes(raw) {
  if (!Array.isArray(raw)) return [];
  const set = new Set();
  for (const e of raw) {
    const n = Number(e);
    if (Number.isInteger(n) && n >= 1) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * 计算某个日期生效的更新星期：
 * 首段沿用 baseWeekday，跳过任一「换周」节点（node.date <= dateKey）后改用对应星期
 */
function effectiveWeekdayAt(baseWeekday, shifts, dateKey) {
  let wd = baseWeekday;
  for (const s of shifts) {
    if (s.date <= dateKey) wd = s.weekday;
    else break;
  }
  return wd;
}

/**
 * 返回满足 targetWeekday 且不早于 fromDate 的最近日期
 */
function snapToWeekday(fromDate, targetWeekday) {
  const d = parseDateOnly(fromDate);
  if (!d) return null;
  const delta = (targetWeekday - d.getDay() + 7) % 7;
  const r = new Date(d);
  r.setDate(r.getDate() + delta);
  return r;
}

/**
 * 从首播日按周推进，结合 overrides（指定日的集数/连播）与 weekdayShifts（季中换周）生成完整日程
 * 换周只影响换周日及之后的日期；换周日之前的日期与不换周完全一致。
 * 返回 { schedule: {date:{start,count}}, startDate, endDate, totalEpisodes, weekday }
 */
export function buildEpisodeSchedule(anime) {
  const overrides = normalizeOverrides(anime.episodeOverrides);
  const shifts = normalizeWeekdayShifts(anime.weekdayShifts);
  const epDates = normalizeEpisodeDates(anime.episodeDates);
  let totalEpisodes = Number(anime.totalEpisodes) || DEFAULT_EPISODES;
  if (totalEpisodes < 1) totalEpisodes = DEFAULT_EPISODES;

  // 覆盖里出现的最大集数，可能抬高总集数
  for (const o of Object.values(overrides)) {
    totalEpisodes = Math.max(totalEpisodes, o.start + o.count - 1);
  }

  // —— 真实播出日期模式：使用 Bangumi 每集的真实放送日，不再按周推算 ——
  if (epDates.some(Boolean)) {
    // 按日期合并同一天播出的连续集（例如连播两集 -> 当天 {start, count:2}）
    const byDate = new Map();
    let maxEp = 0;
    epDates.forEach((date, i) => {
      if (!date) return;
      const ep = i + 1;
      if (ep > maxEp) maxEp = ep;
      const group = byDate.get(date);
      if (group) group.count += 1;
      else byDate.set(date, { start: ep, count: 1 });
    });
    // 手动单日覆盖优先
    for (const [date, ov] of Object.entries(overrides)) {
      byDate.set(date, { start: ov.start, count: ov.count });
      maxEp = Math.max(maxEp, ov.start + ov.count - 1);
    }
    // 总集数以真实日期为准；有存储总集数且更大则沿用（未放送部分未知）
    const storedTotal = Number(anime.totalEpisodes);
    totalEpisodes = Number.isInteger(storedTotal) && storedTotal >= 1
      ? Math.max(storedTotal, maxEp)
      : maxEp;

    const dates = Array.from(byDate.keys()).sort();
    const schedule = {};
    for (const date of dates) schedule[date] = byDate.get(date);
    const firstReal = dates[0] || null;
    const wd = anime.weekday != null
      ? (Number(anime.weekday) === 7 ? 0 : Number(anime.weekday))
      : (firstReal ? parseDateOnly(firstReal).getDay() : 0);
    return {
      schedule,
      startDate: firstReal,
      endDate: dates[dates.length - 1] || null,
      totalEpisodes,
      weekday: wd,
    };
  }

  let start = parseDateOnly(anime.startDate || anime.airDate);
  if (!start && anime.addedAt) start = parseDateOnly(new Date(anime.addedAt));
  if (!start) {
    return { schedule: {}, startDate: null, endDate: null, totalEpisodes };
  }

  const baseWeekday = anime.weekday != null ? Number(anime.weekday) : start.getDay();

  const schedule = {};
  let nextEp = 1;
  let day = snapToWeekday(start, baseWeekday);
  let guard = 0;
  let endDate = formatDateOnly(day);
  const firstDate = formatDateOnly(day);

  while (nextEp <= totalEpisodes && guard < 500) {
    guard += 1;
    const key = formatDateOnly(day);
    const ov = overrides[key];
    if (ov) {
      schedule[key] = { start: ov.start, count: ov.count };
      nextEp = ov.start + ov.count;
      endDate = key;
    } else {
      schedule[key] = { start: nextEp, count: 1 };
      nextEp += 1;
      endDate = key;
    }
    // 名义上按周推进，再吸附到「名义日期」当天生效的更新星期（换周即在此切换）
    const nominal = addWeeks(day, 1);
    day = snapToWeekday(nominal, effectiveWeekdayAt(baseWeekday, shifts, formatDateOnly(nominal)));
  }

  return {
    schedule,
    startDate: firstDate,
    endDate,
    totalEpisodes,
    weekday: baseWeekday,
  };
}

export function resolveAirRange(anime) {
  const built = buildEpisodeSchedule(anime);
  if (built.startDate) {
    return {
      startDate: built.startDate,
      endDate: built.endDate,
      totalEpisodes: built.totalEpisodes,
    };
  }

  let start = parseDateOnly(anime.startDate || anime.airDate);
  if (!start && anime.addedAt) start = parseDateOnly(new Date(anime.addedAt));
  let totalEpisodes = anime.totalEpisodes ? Number(anime.totalEpisodes) : null;
  if (totalEpisodes != null && (Number.isNaN(totalEpisodes) || totalEpisodes < 1)) totalEpisodes = null;
  let end = parseDateOnly(anime.endDate);
  if (!end && start && totalEpisodes) end = computeEndDate(start, totalEpisodes);
  if (!end && start && !totalEpisodes) {
    totalEpisodes = DEFAULT_EPISODES;
    end = computeEndDate(start, totalEpisodes);
  }
  return {
    startDate: start ? formatDateOnly(start) : null,
    endDate: end ? formatDateOnly(end) : null,
    totalEpisodes,
  };
}

export function isAiringOnDate(anime, date) {
  const day = parseDateOnly(date);
  if (!day) return false;
  const key = formatDateOnly(day);
  const built = buildEpisodeSchedule(anime);
  return Boolean(built.schedule[key]);
}

export function getEpisodeInfoForDate(anime, date) {
  const key = formatDateOnly(date);
  if (!key) return null;
  const built = buildEpisodeSchedule(anime);
  const slot = built.schedule[key];
  if (!slot) return null;
  return {
    start: slot.start,
    count: slot.count,
    label: formatEpisodeLabel(slot.start, slot.count),
    end: slot.start + slot.count - 1,
  };
}

export function getEpisodeNumberForDate(anime, date) {
  const info = getEpisodeInfoForDate(anime, date);
  return info ? info.start : null;
}

/**
 * 手动设定某日播出集数，并重算首播/完结日与前后覆盖编号
 * @param {string} animeId
 * @param {string|Date} date
 * @param {number} startEp 本日起始集
 * @param {number} count 本日连播集数
 */
export function adjustEpisodeOnDate(animeId, date, startEp, count = 1) {
  const data = loadData();
  const idx = data.myAnime.findIndex(a => a.id === animeId);
  if (idx < 0) return { success: false, message: '未找到该番剧' };

  const anime = data.myAnime[idx];
  const pivot = parseDateOnly(date);
  if (!pivot) return { success: false, message: '日期无效' };

  let start = Math.max(1, parseInt(startEp, 10) || 1);
  let epCount = Math.max(1, parseInt(count, 10) || 1);
  const lastEp = start + epCount - 1;
  let totalEpisodes = Number(anime.totalEpisodes) || DEFAULT_EPISODES;
  if (lastEp > totalEpisodes) totalEpisodes = lastEp;

  const pivotKey = formatDateOnly(pivot);
  const oldOverrides = normalizeOverrides(anime.episodeOverrides);

  // 只保留枢纽日之前的「连播天数」信息（用 count），编号稍后重算
  const keptCounts = {};
  for (const [k, v] of Object.entries(oldOverrides)) {
    if (k < pivotKey) keptCounts[k] = v.count;
  }

  // 向前推：需要塞下 start-1 集（若某天连播过多则收缩该天 count）
  let need = start - 1;
  let cursor = new Date(pivot);
  while (need > 0) {
    cursor = addWeeks(cursor, -1);
    const key = formatDateOnly(cursor);
    let c = keptCounts[key] || 1;
    if (c > need) {
      c = need;
      keptCounts[key] = c;
    }
    need -= c;
  }
  const newStartDate = formatDateOnly(cursor);
  const weekday = pivot.getDay();

  // 从新首播重算到枢纽前的覆盖编号
  const newOverrides = {};
  let ep = 1;
  let d = parseDateOnly(newStartDate);
  while (d < pivot) {
    const key = formatDateOnly(d);
    const c = keptCounts[key] || 1;
    if (keptCounts[key]) {
      newOverrides[key] = { start: ep, count: c };
    }
    ep += c;
    d = addWeeks(d, 1);
  }

  // 枢纽日
  newOverrides[pivotKey] = { start, count: epCount };
  ep = start + epCount;

  // 枢纽后：默认每周 1 集，直到播完；丢弃旧的后续覆盖（避免冲突）
  let endDate = pivotKey;
  d = addWeeks(pivot, 1);
  let guard = 0;
  while (ep <= totalEpisodes && guard < 500) {
    guard += 1;
    endDate = formatDateOnly(d);
    ep += 1;
    d = addWeeks(d, 1);
  }

  data.myAnime[idx] = {
    ...anime,
    weekday,
    startDate: newStartDate,
    endDate,
    totalEpisodes,
    episodeOverrides: newOverrides,
    // 手动重排集数后转为「按周推算」模型，放弃 Bangumi 真实日期
    episodeDates: [],
  };
  saveData(data);

  return {
    success: true,
    message: `已将《${anime.name}》在 ${pivotKey} 设为 ${formatEpisodeLabel(start, epCount)}，完结日 ${endDate}`,
    anime: normalizeAnimeRecord(data.myAnime[idx]),
  };
}

/**
 * 计算某部番剧在指定日期生效的更新星期（0-6），无法确定时返回 null
 */
export function getEffectiveWeekdayAtDate(anime, date) {
  let base = anime.weekday != null ? Number(anime.weekday) : null;
  if (base == null) {
    const start = parseDateOnly(anime.startDate || anime.airDate);
    if (start) base = start.getDay();
  }
  if (base == null) return null;
  const shifts = normalizeWeekdayShifts(anime.weekdayShifts);
  return effectiveWeekdayAt(base, shifts, formatDateOnly(date));
}

/**
 * 某部番剧的指定集数是否已标记「已看」
 */
export function isEpisodeWatched(anime, ep) {
  const n = Number(ep);
  if (!Number.isInteger(n) || n < 1) return false;
  return normalizeWatchedEpisodes(anime && anime.watchedEpisodes).includes(n);
}

/**
 * 切换某部番剧的指定集数的「已看」状态
 */
export function toggleEpisodeWatched(animeId, ep) {
  const data = loadData();
  const idx = data.myAnime.findIndex(a => a.id === animeId);
  if (idx < 0) return { success: false, message: '未找到该番剧' };

  const n = Number(ep);
  if (!Number.isInteger(n) || n < 1) return { success: false, message: '集数无效' };

  const anime = data.myAnime[idx];
  const watched = normalizeWatchedEpisodes(anime.watchedEpisodes);
  const has = watched.includes(n);
  const next = has
    ? watched.filter(e => e !== n).sort((a, b) => a - b)
    : [...new Set([...watched, n])].sort((a, b) => a - b);

  data.myAnime[idx] = { ...anime, watchedEpisodes: next };
  saveData(data);
  return { success: true, watched: !has, anime: normalizeAnimeRecord(data.myAnime[idx]) };
}

/**
 * 返回某部番剧每一集的展示状态列表：
 *   { episode, dateKey, aired, watched }
 *   - aired    : 该集是否已到播出日（有真实/推算日期且 <= today）
 *   - watched  : 是否已标记「已看」
 */
export function getEpisodeStatusList(anime, today = new Date()) {
  const built = buildEpisodeSchedule(anime);
  const schedule = built.schedule;
  const epDate = new Map();
  for (const [key, slot] of Object.entries(schedule)) {
    for (let e = slot.start; e < slot.start + slot.count; e++) epDate.set(e, key);
  }
  const todayKey = formatDateOnly(today);
  const total = built.totalEpisodes || 0;
  const list = [];
  for (let ep = 1; ep <= total; ep++) {
    const dk = epDate.get(ep) || null;
    list.push({
      episode: ep,
      dateKey: dk,
      aired: dk ? dk <= todayKey : false,
      watched: isEpisodeWatched(anime, ep),
    });
  }
  return list;
}

/**
 * 季中换播出星期：自指定日期起，该番后续每周改到 weekday 播放。
 * 换周日之前的日期保持不变；被调本集「就近」顺延到新星期的最近日期。
 * @param {string} animeId
 * @param {string|Date} date      换周生效日（被调日期）
 * @param {number} weekday        新的更新星期 0-6（0=周日）
 */
export function addWeekdayShift(animeId, date, weekday) {
  const data = loadData();
  const idx = data.myAnime.findIndex(a => a.id === animeId);
  if (idx < 0) return { success: false, message: '未找到该番剧' };

  const anime = data.myAnime[idx];
  const pivot = parseDateOnly(date);
  if (!pivot) return { success: false, message: '日期无效' };

  let wd = Number(weekday);
  if (wd === 7) wd = 0;
  if (Number.isNaN(wd) || wd < 0 || wd > 6) return { success: false, message: '星期无效' };

  const pivotKey = formatDateOnly(pivot);
  const startKey = anime.startDate ? formatDateOnly(anime.startDate) : null;
  if (startKey && pivotKey <= startKey) {
    return { success: false, message: '调整日期需晚于首播日' };
  }

  const shifts = normalizeWeekdayShifts(anime.weekdayShifts);
  const currentWeekday = getEffectiveWeekdayAtDate(anime, pivot);
  if (currentWeekday === wd) {
    return {
      success: true,
      message: `${pivotKey} 当前已是${WEEKDAY_NAMES[wd]}`,
      anime: normalizeAnimeRecord(data.myAnime[idx]),
    };
  }

  // 同分区段内，被调日期之后的旧星期节点反而更近，若旧节点在 pivot 之后会造成日期回退；统一丢弃被调日之后的换周与逐集覆盖
  const keepShifts = shifts.filter(s => s.date < pivotKey);
  keepShifts.push({ date: pivotKey, weekday: wd });
  keepShifts.sort((a, b) => a.date.localeCompare(b.date));

  const overrides = normalizeOverrides(anime.episodeOverrides);
  for (const k of Object.keys(overrides)) {
    if (k > pivotKey) delete overrides[k];
  }

  data.myAnime[idx] = {
    ...anime,
    weekdayShifts: keepShifts,
    episodeOverrides: overrides,
    // 手动换周即转为按周推算，放弃 Bangumi 真实日期
    episodeDates: [],
  };
  saveData(data);

  return {
    success: true,
    message: `已将从 ${pivotKey} 起的更新日改为${WEEKDAY_NAMES[wd]}（之前的日期不变）`,
    anime: normalizeAnimeRecord(data.myAnime[idx]),
  };
}

/**
 * 撤销某个日期的换周记录（回退到该日期之前生效的星期）
 */
export function removeWeekdayShift(animeId, date) {
  const data = loadData();
  const idx = data.myAnime.findIndex(a => a.id === animeId);
  if (idx < 0) return { success: false, message: '未找到该番剧' };

  const anime = data.myAnime[idx];
  const pivotKey = formatDateOnly(date);
  const next = normalizeWeekdayShifts(anime.weekdayShifts).filter(s => s.date !== pivotKey);
  data.myAnime[idx] = { ...anime, weekdayShifts: next };
  saveData(data);
  return { success: true, anime: normalizeAnimeRecord(data.myAnime[idx]) };
}

function createDefaultData() {
  return {
    version: 3,
    myAnime: [],
    settings: {
      autoUpdate: true,
      alwaysOnTop: true,
      startMinimized: false,
    },
    lastFetch: null,
  };
}

function normalizeAnimeRecord(raw) {
  const range = resolveAirRange(raw);
  return {
    ...raw,
    cover: toHttps(raw.cover),
    startDate: range.startDate || raw.startDate || null,
    endDate: range.endDate || raw.endDate || null,
    totalEpisodes: range.totalEpisodes ?? raw.totalEpisodes ?? null,
    episodeOverrides: normalizeOverrides(raw.episodeOverrides),
    weekdayShifts: normalizeWeekdayShifts(raw.weekdayShifts),
    episodeDates: normalizeEpisodeDates(raw.episodeDates),
    watchedEpisodes: normalizeWatchedEpisodes(raw.watchedEpisodes),
  };
}

export function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultData();
    const data = JSON.parse(raw);
    // settings 逐字段合并到默认值，避免旧版本只存了部分配置导致字段缺失
    return {
      ...createDefaultData(),
      ...data,
      settings: { ...createDefaultData().settings, ...(data.settings || {}) },
      myAnime: Array.isArray(data.myAnime) ? data.myAnime : [],
    };
  } catch {
    return createDefaultData();
  }
}

export function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function addMyAnime(anime) {
  const data = loadData();
  const exists = data.myAnime.some(
    a => (a.bangumiId && a.bangumiId === anime.bangumiId) || (a.name === anime.name)
  );
  if (exists) {
    return { success: false, message: '该番剧已在关注列表中', alreadyExists: true };
  }

  let weekday = anime.weekday ?? 1;
  weekday = Number(weekday);
  if (weekday === 7) weekday = 0;

  const range = resolveAirRange({
    startDate: anime.startDate || anime.airDate || null,
    endDate: anime.endDate || null,
    totalEpisodes: anime.totalEpisodes || null,
    episodeDates: normalizeEpisodeDates(anime.episodeDates),
  });

  if (range.startDate) {
    const start = parseDateOnly(range.startDate);
    if (start) weekday = start.getDay();
  }

  data.myAnime.push({
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36),
    name: anime.name,
    bangumiId: anime.bangumiId || null,
    weekday,
    airTime: anime.airTime || '',
    cover: toHttps(anime.cover || ''),
    startDate: range.startDate,
    endDate: range.endDate,
    totalEpisodes: range.totalEpisodes,
    currentEpisode: anime.currentEpisode || 1,
    episodeOverrides: normalizeOverrides(anime.episodeOverrides),
    weekdayShifts: normalizeWeekdayShifts(anime.weekdayShifts),
    episodeDates: normalizeEpisodeDates(anime.episodeDates),
    watchedEpisodes: normalizeWatchedEpisodes(anime.watchedEpisodes),
    addedAt: Date.now(),
  });
  saveData(data);
  const tip = range.startDate && range.endDate
    ? `（${range.startDate} ~ ${range.endDate}）`
    : '';
  return { success: true, message: `已添加《${anime.name}》${tip}` };
}

export function updateMyAnime(animeId, patch) {
  const data = loadData();
  const idx = data.myAnime.findIndex(a => a.id === animeId);
  if (idx < 0) return { success: false, message: '未找到该番剧' };
  const merged = {
    ...data.myAnime[idx],
    ...patch,
    episodeOverrides: normalizeOverrides(
      patch.episodeOverrides !== undefined
        ? patch.episodeOverrides
        : data.myAnime[idx].episodeOverrides
    ),
  };
  const range = resolveAirRange(merged);
  data.myAnime[idx] = {
    ...merged,
    cover: toHttps(merged.cover || ''),
    startDate: range.startDate,
    endDate: range.endDate,
    totalEpisodes: range.totalEpisodes,
  };
  saveData(data);
  return { success: true, anime: data.myAnime[idx] };
}

export function removeMyAnime(animeId) {
  const data = loadData();
  const anime = data.myAnime.find(a => a.id === animeId);
  data.myAnime = data.myAnime.filter(a => a.id !== animeId);
  saveData(data);
  return { success: true, anime };
}

export function removeMyAnimeByBangumiId(bangumiId) {
  const data = loadData();
  const id = Number(bangumiId);
  const anime = data.myAnime.find(a => a.bangumiId === id || a.bangumiId === bangumiId);
  if (!anime) return { success: false, message: '未找到该番剧' };
  data.myAnime = data.myAnime.filter(a => a.id !== anime.id);
  saveData(data);
  return { success: true, anime, message: `已取消关注《${anime.name}》` };
}

export function removeMyAnimeByName(name) {
  const data = loadData();
  const anime = data.myAnime.find(a => a.name === name);
  if (!anime) return { success: false, message: '未找到该番剧' };
  data.myAnime = data.myAnime.filter(a => a.id !== anime.id);
  saveData(data);
  return { success: true, anime, message: `已取消关注《${anime.name}》` };
}

export function findByBangumiId(bangumiId) {
  const id = Number(bangumiId);
  return getMyAnime().find(a => a.bangumiId === id || a.bangumiId === bangumiId) || null;
}

export function getMyAnime() {
  return loadData().myAnime.map(normalizeAnimeRecord);
}

export function updateSettings(settings) {
  const data = loadData();
  data.settings = { ...data.settings, ...settings };
  saveData(data);
}

export function getSettings() {
  return loadData().settings;
}

export function setLastFetch(ts = Date.now()) {
  const data = loadData();
  data.lastFetch = ts;
  saveData(data);
}

export function getAnimeForDate(date) {
  const key = formatDateOnly(date);
  const result = [];
  for (const anime of getMyAnime()) {
    const built = buildEpisodeSchedule(anime);
    const slot = built.schedule[key];
    if (!slot) continue;
    // 同一天连播多集时拆成多张卡片，每张代表一集，各自独立勾选「已看」
    const watchSet = new Set(normalizeWatchedEpisodes(anime.watchedEpisodes));
    for (let ep = slot.start; ep < slot.start + slot.count; ep++) {
      result.push({
        ...anime,
        episode: ep,
        totalEpisodes: built.totalEpisodes,
        label: `第 ${ep} 集`,
        watched: watchSet.has(ep),
      });
    }
  }

  result.sort((a, b) => {
    if (!a.airTime) return 1;
    if (!b.airTime) return -1;
    const t = a.airTime.localeCompare(b.airTime);
    return t !== 0 ? t : a.episode - b.episode;
  });

  return result;
}

export function getTodayUpdateCount() {
  return getAnimeForDate(new Date()).length;
}

export function getUpdateCountsForMonth(year, month) {
  const stats = {};
  // 预生成当月天数对应的 "YYYY-MM-DD" 键，避免在循环里重复解析日期
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const days = new Array(daysInMonth);
  for (let day = 1; day <= daysInMonth; day++) {
    days[day - 1] = { key: formatDateOnly(new Date(year, month, day)) };
  }

  // 每部番只构建一次完整日程，再以 O(1) 查当月每天的键，
  // 取代原来“每天×每部番”都重建日程的 O(月天数×部数×集数) 开销
  // 注意：同一天连播多集按多集计，episodes 为该日总集数，unwatched 为该日未看集数
  for (const anime of getMyAnime()) {
    const schedule = buildEpisodeSchedule(anime).schedule;
    const watchSet = new Set(normalizeWatchedEpisodes(anime.watchedEpisodes));
    for (let i = 0; i < daysInMonth; i++) {
      const slot = schedule[days[i].key];
      if (!slot) continue;
      let cur = stats[i + 1] || (stats[i + 1] = { episodes: 0, unwatched: 0 });
      cur.episodes += slot.count;
      for (let ep = slot.start; ep < slot.start + slot.count; ep++) {
        if (!watchSet.has(ep)) cur.unwatched += 1;
      }
    }
  }

  return stats;
}

export function importFromBangumi(bangumiItem) {
  let weekday = bangumiItem.weekday;
  if (weekday == null) weekday = 1;
  weekday = parseInt(weekday, 10);
  if (weekday === 7) weekday = 0;
  if (Number.isNaN(weekday) || weekday < 0 || weekday > 6) weekday = 1;

  const startDate = bangumiItem.start_date || bangumiItem.air_date || bangumiItem.date || null;
  const endDate = bangumiItem.end_date || null;
  const totalEpisodes = bangumiItem.eps || bangumiItem.total_episodes || bangumiItem.totalEpisodes || null;

  return addMyAnime({
    name: bangumiItem.name_cn || bangumiItem.name,
    bangumiId: bangumiItem.id,
    weekday,
    airTime: bangumiItem.air_time || '',
    cover: toHttps(
      bangumiItem.images?.common || bangumiItem.images?.medium || bangumiItem.image || ''
    ),
    startDate,
    endDate,
    totalEpisodes,
    episodeDates: bangumiItem.episode_dates,
    currentEpisode: bangumiItem.eps_count || 1,
  });
}

export function backfillAirRange(animeId, info) {
  return updateMyAnime(animeId, {
    startDate: info.start_date || info.air_date || info.date || null,
    endDate: info.end_date || null,
    totalEpisodes: info.eps || info.total_episodes || info.totalEpisodes || null,
    episodeDates: info.episode_dates,
    weekday: info.weekday != null ? info.weekday : undefined,
    airTime: info.air_time || undefined,
    cover: info.images?.common || info.image || undefined,
  });
}

export function batchAddAnime(animeList) {
  return animeList.map(anime => addMyAnime(anime));
}
