/**
 * 季度数据本地缓存模块
 * - 元数据（列表、星期、日期、集数、评分、bangumiId 等）：体积小，存 localStorage
 * - 封面缩略图（dataURL 二进制）：体积大，存 IndexedDB，按封面 URL 建索引
 *
 * 策略：打开时先读缓存，缓存为空/过期才去 yuc.wiki + Bangumi 主动拉取；
 * 缩略图只保留最近两次成功抓取引用到的封面，其余定期清理，避免无限增长。
 */

const SEASON_CACHE_KEY = 'anime_cal_season_cache';
const THUMB_DB_NAME = 'anime_cal_thumbs';
const THUMB_STORE = 'thumbs';
const THUMB_DB_VERSION = 1;

/** 缓存有效期：超过则视为「很旧」，重新拉取 */
export const SEASON_CACHE_TTL = 12 * 60 * 60 * 1000;

// ---------- 季度元数据缓存（localStorage） ----------

export function readSeasonCache() {
  try {
    const raw = localStorage.getItem(SEASON_CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.byWeekday) return null;
    return data;
  } catch {
    return null;
  }
}

export function isCacheFresh(cache, ttl = SEASON_CACHE_TTL) {
  return !!(cache && cache.fetchedAt && (Date.now() - cache.fetchedAt) < ttl);
}

/**
 * 写入季度元数据缓存，返回本次「应保留」的封面 URL 集合（本季 + 上一季的并集），
 * 供缩略图清理使用。写入时剔除 thumb / __ 前缀等瞬态字段，避免本地存储膨胀。
 */
export function writeSeasonCache(byWeekday, total) {
  const covers = [];
  const seenCover = new Set();
  const clean = {};
  for (const w in byWeekday) {
    clean[w] = (byWeekday[w] || []).map(it => {
      if (it.cover && !seenCover.has(it.cover)) {
        seenCover.add(it.cover);
        covers.push(it.cover);
      }
      const out = {};
      for (const k in it) {
        if (k === 'thumb' || k.startsWith('_')) continue;
        out[k] = it[k];
      }
      return out;
    });
  }

  let prevCovers = [];
  try {
    const prev = JSON.parse(localStorage.getItem(SEASON_CACHE_KEY) || 'null');
    if (prev && Array.isArray(prev.covers)) prevCovers = prev.covers;
  } catch {
    /* ignore */
  }

  try {
    localStorage.setItem(SEASON_CACHE_KEY, JSON.stringify({
      byWeekday: clean,
      total,
      fetchedAt: Date.now(),
      covers,
    }));
  } catch (err) {
    console.warn('写入季度缓存失败', err);
    return { keepKeys: new Set(covers) };
  }
  return { keepKeys: new Set([...covers, ...prevCovers]) };
}

export function clearSeasonCache() {
  try {
    localStorage.removeItem(SEASON_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- 封面缩略图缓存（IndexedDB） ----------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(THUMB_DB_NAME, THUMB_DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(THUMB_STORE)) {
        db.createObjectStore(THUMB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

export async function getThumb(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(THUMB_STORE, 'readonly');
      const req = tx.objectStore(THUMB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveThumb(key, dataUrl) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(THUMB_STORE, 'readwrite');
      tx.objectStore(THUMB_STORE).put(dataUrl, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

/** 删除不在 keepKeys 中的缩略图，返回删除数量 */
export async function pruneThumbs(keepKeys) {
  try {
    const keep = keepKeys instanceof Set ? keepKeys : new Set(keepKeys || []);
    const db = await openDb();
    const keys = await new Promise((resolve) => {
      const tx = db.transaction(THUMB_STORE, 'readonly');
      const req = tx.objectStore(THUMB_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    const toDelete = keys.filter(k => !keep.has(k));
    if (!toDelete.length) return 0;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(THUMB_STORE, 'readwrite');
      const store = tx.objectStore(THUMB_STORE);
      toDelete.forEach(k => store.delete(k));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return toDelete.length;
  } catch {
    return 0;
  }
}