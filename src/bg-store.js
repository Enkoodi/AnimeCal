/**
 * 背景「原图」的存放处（IndexedDB）
 *
 * 裁剪结果（小、需要被首屏同步读取）放 localStorage；
 * 用户选的原图（可能几 MB）放这里：IndexedDB 直接存 Blob，
 * 不做 base64 膨胀、也不占用 localStorage 那 5MB 配额，
 * 各窗口同 origin、同 `.data` 目录，所以随时都能取回原图重新裁剪。
 *
 * 用 IndexedDB 的原因：把原图塞进 localStorage 会连同三张裁剪结果一起逼近配额上限，
 * 而 JPEG 转 base64 还要再膨胀 33%，一旦超限就连背景本身都存不进去。
 */
const DB_NAME = 'anime_cal_media';
const STORE_NAME = 'background_sources';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败'));
  });
  // 失败就不要缓存这个 rejected promise，下次还有机会重试
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function run(mode, action) {
  return openDb().then(
    db =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = action(transaction.objectStore(STORE_NAME));
        let value;
        if (request) request.onsuccess = () => { value = request.result; };
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

/** 保存某个窗口的原图（Blob） */
export function saveSource(target, blob) {
  return run('readwrite', store => store.put(blob, target)).then(() => true);
}

/** 取回某个窗口的原图，没有则返回 null */
export function loadSource(target) {
  return run('readonly', store => store.get(target)).then(value => value || null);
}

export function deleteSource(target) {
  return run('readwrite', store => store.delete(target)).then(() => true);
}
