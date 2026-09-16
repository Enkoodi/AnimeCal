/**
 * 自定义窗口背景
 * - 每个窗口（主窗口 / 添加番剧 / 管理番剧）各存一张已裁剪好的图片，互不影响
 * - 图片以 data URL 形式存在 localStorage（各窗口共用同一 origin / 同一 .data 目录）
 * - 真正把图片贴到页面上的是 public/bg-boot.js（在 <head> 里同步执行，避免开窗时闪一下底色），
 *   这里只负责读写数据、调用它重绘、以及在跨窗口变更时通知各页面
 */
import { invoke } from '@tauri-apps/api/core';

export const BG_STORAGE_KEY = 'anime_cal_backgrounds';
export const DEFAULT_SCRIM = 0.45;
/** 缩放的上下限：100% = 恰好铺满取景框（再小就会露出空白），400% = 放大 4 倍 */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** 保存时按窗口逻辑尺寸的 2 倍渲染，长边再限制到 1280，兼顾清晰度与 localStorage 容量 */
const OUTPUT_SCALE = 2;
const OUTPUT_MAX_EDGE = 1280;
const OUTPUT_QUALITY = 0.8;

/** 三个窗口的标识、中文名与逻辑尺寸（尺寸用于取景框比例与输出像素） */
export const BG_TARGETS = {
  main: { label: '主窗口', width: 400, height: 480 },
  manager: { label: '添加番剧', width: 760, height: 680 },
  following: { label: '管理番剧', width: 460, height: 600 },
};

/** 裁剪后要保存成多大的图（保持目标窗口比例） */
export function outputSizeFor(target) {
  const t = BG_TARGETS[target] || BG_TARGETS.main;
  let w = t.width * OUTPUT_SCALE;
  let h = t.height * OUTPUT_SCALE;
  const long = Math.max(w, h);
  if (long > OUTPUT_MAX_EDGE) {
    const k = OUTPUT_MAX_EDGE / long;
    w = Math.round(w * k);
    h = Math.round(h * k);
  }
  return { width: w, height: h, quality: OUTPUT_QUALITY };
}

function emptyStore() {
  return { scrim: DEFAULT_SCRIM, windows: {} };
}

export function loadBackgrounds() {
  try {
    const raw = localStorage.getItem(BG_STORAGE_KEY);
    if (!raw) return emptyStore();
    const data = JSON.parse(raw);
    return {
      scrim: typeof data.scrim === 'number' ? data.scrim : DEFAULT_SCRIM,
      windows: data.windows && typeof data.windows === 'object' ? data.windows : {},
    };
  } catch {
    return emptyStore();
  }
}

function persist(store) {
  try {
    localStorage.setItem(BG_STORAGE_KEY, JSON.stringify(store));
    return { success: true };
  } catch (err) {
    // 容量超限时由调用方决定是提示用户还是压缩重试
    const quota = /quota|exceed/i.test(String(err && err.name) + String(err && err.message));
    return {
      success: false,
      quota,
      message: quota ? '背景图片过大，存储空间不足' : '背景保存失败',
    };
  }
}

/** 某个窗口当前的背景记录：{ data, updatedAt, crop? } | null */
export function getBackground(target) {
  const item = loadBackgrounds().windows[target];
  return item && item.data ? item : null;
}

/**
 * 保存裁剪结果。
 * @param {string} target 目标窗口
 * @param {string} dataUrl 裁剪后的 JPEG data URL
 * @param {object} [crop] 取景框对应的原图范围（按原图宽高归一化的 {u,v,w,h}），
 *   下次打开裁剪窗口时据此还原大小与位置；只存比例，与裁剪窗口自身尺寸无关。
 */
export function setBackground(target, dataUrl, crop = null) {
  if (!BG_TARGETS[target]) return { success: false, message: '未知的窗口' };
  const store = loadBackgrounds();
  const record = { data: dataUrl, updatedAt: Date.now() };
  if (crop && Number.isFinite(crop.u) && Number.isFinite(crop.v) && crop.w > 0 && crop.h > 0) {
    record.crop = crop;
  }
  store.windows[target] = record;
  return persist(store);
}

export function removeBackground(target) {
  const store = loadBackgrounds();
  if (!store.windows[target]) return { success: true };
  delete store.windows[target];
  return persist(store);
}

export function getScrim() {
  return loadBackgrounds().scrim;
}

export function setScrim(value) {
  const store = loadBackgrounds();
  store.scrim = Math.min(0.8, Math.max(0, Number(value) || 0));
  return persist(store);
}

/**
 * 把「本窗口」的背景应用到页面上。
 * @param {'main'|'manager'|'following'} target 本窗口的标识（注意不是被编辑的那个窗口）
 */
export function applyBackground(target) {
  if (typeof window.__applyStoredBackground === 'function') {
    window.__applyStoredBackground(target);
  }
}

/** 通知其它窗口背景已变化（本窗口不会收到自己的广播） */
export async function notifyBackgroundChanged() {
  try {
    await invoke('notify_background_changed');
  } catch (err) {
    console.warn('notify_background_changed failed', err);
  }
}

/** 打开「自定义背景」裁剪窗口：由 Rust 创建，保证 data_directory 与主窗口一致 */
export async function openCropWindow(target) {
  if (!BG_TARGETS[target]) return;
  if (!window.__TAURI__) {
    window.open(`./crop.html?target=${target}`, `crop-${target}`, 'width=900,height=640');
    return;
  }
  try {
    await invoke('open_crop_window', { target });
  } catch (err) {
    console.error('open_crop_window failed', err);
  }
}

const listeners = [];
let listening = false;

function fire() {
  for (const fn of listeners.slice()) {
    try {
      fn();
    } catch (err) {
      console.warn('background change handler failed', err);
    }
  }
}

function ensureListener() {
  if (listening) return;
  listening = true;
  try {
    const pending = window.__TAURI__?.event?.listen?.('background-changed', fire);
    if (pending && typeof pending.catch === 'function') {
      pending.catch((err) => console.warn('listen background-changed failed', err));
    }
  } catch (err) {
    console.warn('listen background-changed failed', err);
  }
  // storage 是兜底：同一个 .data 目录下各窗口 localStorage 一致，改动会互相触发
  window.addEventListener('storage', (e) => {
    if (e.key === BG_STORAGE_KEY) fire();
  });
}

/**
 * 页面启动时调用：先应用已存背景，之后任何窗口改动背景都会回调 onChange。
 * 实际逻辑在 public/bg-boot.js（window.__applyStoredBackground），两处共用一份实现。
 * @param {'main'|'manager'|'following'} target 本窗口标识
 * @param {Function} [onChange] 背景变化后的额外处理（如刷新设置页里的缩略图）
 */
export function initBackground(target, onChange) {
  applyBackground(target);
  const handler = () => {
    applyBackground(target);
    if (onChange) onChange();
  };
  listeners.push(handler);
  ensureListener();
}
