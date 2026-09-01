/**
 * Bangumi API 接口模块
 */

const BANGUMI_API = 'https://api.bgm.tv';
const WEEKDAY_CN = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
};

/** Bangumi 常返回 http 图床地址，WebView CSP 会拦截，统一升为 https */
export function normalizeImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let u = url.trim();
  if (u.startsWith('//')) u = `https:${u}`;
  if (u.startsWith('http://')) u = `https://${u.slice(7)}`;
  return u;
}

function pickCover(images = {}) {
  return normalizeImageUrl(
    images.common || images.medium || images.large || images.small || images.grid || ''
  );
}

/**
 * 解析 Bangumi 放送星期（中文 / 数字 / 英文）为 0-6（周日=0）
 */
export function parseWeekday(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && !Number.isNaN(value)) {
    const n = Math.trunc(value);
    if (n === 7) return 0;
    if (n >= 0 && n <= 6) return n;
    return null;
  }

  const s = String(value).trim();
  const num = Number(s);
  if (!Number.isNaN(num) && s !== '') {
    return parseWeekday(num);
  }

  const cnMatch = s.match(/[日天一二三四五六]/);
  if (cnMatch) return WEEKDAY_CN[cnMatch[0]];

  const en = s.toLowerCase();
  const enMap = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
  };
  for (const [k, v] of Object.entries(enMap)) {
    if (en.includes(k)) return v;
  }
  return null;
}

/** 从任意字符串中提取 YYYY-MM-DD */
export function extractDateString(value) {
  if (!value) return null;
  if (typeof value === 'object' && value !== null) {
    // infobox 偶尔是数组
    if (Array.isArray(value)) {
      for (const v of value) {
        const found = extractDateString(v);
        if (found) return found;
      }
      return null;
    }
    return extractDateString(value.v ?? value.value ?? String(value));
  }
  const s = String(value).trim();
  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }
  const cn = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (cn) {
    return `${cn[1]}-${cn[2].padStart(2, '0')}-${cn[3].padStart(2, '0')}`;
  }
  return null;
}

function weekdayFromAirDate(airDate) {
  const s = extractDateString(airDate);
  if (!s) return null;
  const d = new Date(s + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return null;
  return d.getDay();
}

function addWeeksYmd(ymd, weeks) {
  const s = extractDateString(ymd);
  if (!s) return null;
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() + weeks * 7);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function bangumiFetch(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'AnimeCal/1.0 (https://github.com/animecal)',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** 每页抓取条数（Bangumi /episodes 单页上限） */
const EPS_PAGE = 100;
/** 最多抓取页数，避免异常数据造成无谓请求 */
const EPS_MAX_PAGES = 50;

/**
 * 分页抓取全部正片（type=0）章节。
 * 返回 { items: [{sort, airdate}], total }，items 按 sort（集数）升序，airdate 保留 null（未放送/未知）
 */
export async function getSubjectEpisodes(subjectId) {
  const items = [];
  let offset = 0;
  let total = null;
  for (let page = 0; page < EPS_MAX_PAGES; page++) {
    const data = await bangumiFetch(
      `${BANGUMI_API}/v0/episodes?subject_id=${subjectId}&type=0&limit=${EPS_PAGE}&offset=${offset}`
    );
    const batch = data.data || [];
    total = data.total ?? batch.length;
    for (const ep of batch) {
      items.push({ sort: ep.sort ?? ep.ep ?? 0, airdate: extractDateString(ep.airdate) });
    }
    if (batch.length < EPS_PAGE) break;
    offset += batch.length;
    if (total != null && offset >= total) break;
  }
  items.sort((a, b) => a.sort - b.sort);
  return { items, total };
}

/**
 * 拉取正片章节的首末放送日
 */
export async function getSubjectEpisodeRange(subjectId) {
  try {
    const { items, total } = await getSubjectEpisodes(subjectId);
    const dated = items.filter(ep => ep.airdate);
    if (!dated.length) {
      return { start_date: null, end_date: null, eps: total };
    }
    return {
      start_date: dated[0].airdate,
      end_date: dated[dated.length - 1].airdate,
      eps: total ?? dated.length,
      aired_count: dated.length,
    };
  } catch (error) {
    console.warn('获取章节放送日失败:', error);
    return { start_date: null, end_date: null, eps: null };
  }
}

export async function searchBangumi(keyword, options = {}) {
  // large 会返回 rating.score / rank，用于缺失评分时的补充展示
  const responseGroup = options.large ? 'large' : 'small';
  const maxResults = options.maxResults || 20;
  const url = `${BANGUMI_API}/search/subject/${encodeURIComponent(keyword)}?type=2&responseGroup=${responseGroup}&max_results=${maxResults}`;
  try {
    const data = await bangumiFetch(url);
    return (data.list || []).map(item => ({
      id: item.id,
      name: item.name,
      name_cn: item.name_cn || item.name,
      image: pickCover(item.images),
      air_date: extractDateString(item.air_date) || item.air_date || '',
      weekday: weekdayFromAirDate(item.air_date),
      type: item.type,
      url: item.url || `https://bgm.tv/subject/${item.id}`,
      rating: item.rating?.score ?? null,
      eps: item.eps || item.eps_count || null,
      eps_count: item.eps_count || 1,
    }));
  } catch (error) {
    console.error('Bangumi 搜索失败:', error);
    throw new Error('搜索失败，请检查网络连接');
  }
}

/**
 * 轻量拉取番剧摘要（匹配阶段用于按集数/日期对齐，不拉取每集详情，避免重复请求）
 */
export async function getSubjectBrief(subjectId) {
  const url = `${BANGUMI_API}/v0/subjects/${subjectId}`;
  const data = await bangumiFetch(url);
  const infobox = data.infobox || [];
  const getInfo = (key) => infobox.find(i => i.key === key)?.value ?? null;
  const start_date = extractDateString(getInfo('放送开始')) || extractDateString(data.date) || null;
  return {
    id: data.id,
    name: data.name,
    name_cn: data.name_cn || data.name,
    eps: data.eps || data.total_episodes || null,
    start_date,
  };
}

export async function getSubjectDetail(subjectId) {
  const url = `${BANGUMI_API}/v0/subjects/${subjectId}`;
  try {
    const data = await bangumiFetch(url);
    const infobox = data.infobox || [];
    const getInfo = (key) => infobox.find(i => i.key === key)?.value ?? null;

    let weekday = parseWeekday(getInfo('放送星期'));
    const startFromInfo = extractDateString(getInfo('放送开始')) || extractDateString(data.date);
    const endFromInfo =
      extractDateString(getInfo('播放结束')) ||
      extractDateString(getInfo('放送结束')) ||
      extractDateString(getInfo('完结'));

    if (weekday == null) weekday = weekdayFromAirDate(startFromInfo || data.date);

    let airTime = '';
    const airStart = getInfo('放送开始') || getInfo('放送时间') || '';
    if (typeof airStart === 'string') {
      const timeMatch = airStart.match(/(\d{1,2}:\d{2})/);
      airTime = timeMatch ? timeMatch[1] : '';
    }

    const eps = data.eps || data.total_episodes || null;
    let start_date = startFromInfo || extractDateString(data.date);
    let end_date = endFromInfo;

    // 拉取全部章节，得到真实的每集放送日（覆盖停播/连播/延迟）与首末日期
    const epList = await getSubjectEpisodes(subjectId);
    const epDated = epList.items.filter(ep => ep.airdate);
    const epRange = {
      start_date: epDated.length ? epDated[0].airdate : null,
      end_date: epDated.length ? epDated[epDated.length - 1].airdate : null,
      eps: epList.total,
      aired_count: epDated.length,
    };
    // 按集数顺序的每集放送日（未放送/未知为 null）
    const episode_dates = epList.items.map(ep => ep.airdate);

    if (!start_date && epRange.start_date) start_date = epRange.start_date;
    if (epRange.end_date) {
      // 已完结：章节末集更准；未播完时末集可能是「已播最新」，再用集数推算
      if (eps && epRange.aired_count && epRange.aired_count >= eps) {
        end_date = epRange.end_date;
      } else if (!end_date && eps && start_date) {
        end_date = addWeeksYmd(start_date, eps - 1);
      } else if (!end_date && epRange.aired_count && eps && epRange.aired_count < eps && start_date) {
        end_date = addWeeksYmd(start_date, eps - 1);
      } else if (!end_date) {
        end_date = epRange.end_date;
      }
    } else if (!end_date && eps && start_date) {
      end_date = addWeeksYmd(start_date, eps - 1);
    }

    if (weekday == null && start_date) weekday = weekdayFromAirDate(start_date);

    const images = data.images || {};
    return {
      id: data.id,
      name: data.name,
      name_cn: data.name_cn || data.name,
      weekday,
      air_time: airTime,
      air_date: start_date || '',
      start_date: start_date || null,
      end_date: end_date || null,
      date: start_date || data.date || '',
      eps: eps || epRange.eps || null,
      total_episodes: eps || epRange.eps || null,
      episode_dates,
      images: {
        ...images,
        common: pickCover(images),
        medium: normalizeImageUrl(images.medium),
        large: normalizeImageUrl(images.large),
      },
      image: pickCover(images),
      summary: data.summary || '',
      platform: data.platform || '',
      rating: data.rating?.score || null,
    };
  } catch (error) {
    console.error('获取番剧详情失败:', error);
    throw error;
  }
}

export async function getCurrentSeasonAnime() {
  // Bangumi /calendar 返回「当前正在放送」列表，换季后由 Bangumi 侧更新；
  // 加时间戳避免 WebView 缓存旧季度数据
  const url = `${BANGUMI_API}/calendar?_=${Date.now()}`;
  try {
    const data = await bangumiFetch(url);
    const result = {};
    for (const dayGroup of data) {
      // Bangumi calendar: weekday.id 是 1-7（周一到周日）
      let weekday = dayGroup.weekday?.id;
      if (weekday === 7) weekday = 0;
      result[weekday] = (dayGroup.items || []).map(item => {
        const images = item.images || {};
        const cover = pickCover(images);
        const air_date = extractDateString(item.air_date) || item.air_date || '';
        const eps = item.eps || item.total_episodes || null;
        let end_date = null;
        if (air_date && eps) end_date = addWeeksYmd(air_date, eps - 1);
        return {
          id: item.id,
          name: item.name,
          name_cn: item.name_cn || item.name,
          weekday,
          air_time: item.air_time || '',
          air_date,
          start_date: air_date || null,
          end_date,
          eps,
          eps_count: item.eps_count || 1,
          images: { ...images, common: cover, medium: normalizeImageUrl(images.medium) },
          image: cover,
          rating: item.rating?.score || null,
          url: `https://bgm.tv/subject/${item.id}`,
        };
      });
    }
    return result;
  } catch (error) {
    console.error('获取当季番剧失败:', error);
    throw new Error('获取番剧列表失败，请检查网络连接');
  }
}

export function createDebouncedSearch(delay = 400) {
  let timeout = null;
  return (keyword, callback) => {
    clearTimeout(timeout);
    if (!keyword.trim()) {
      callback([]);
      return;
    }
    timeout = setTimeout(async () => {
      try {
        callback(await searchBangumi(keyword));
      } catch {
        callback([]);
      }
    }, delay);
  };
}
