/**
 * 「自定义背景」裁剪窗口
 * - 取景框比例 = 目标窗口的比例（主窗口 400x480 / 添加番剧 760x680 / 管理番剧 460x600）
 * - 拖动平移、滚轮或滑杆缩放；图片始终铺满取景框，不会露出空白
 * - 保存时按取景框内容渲染成 JPEG（data URL）写进 localStorage，并广播给所有窗口
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { loadSource, saveSource } from './bg-store.js';
import {
  BG_TARGETS,
  MAX_ZOOM,
  getBackground,
  getScrim,
  outputSizeFor,
  setBackground,
  notifyBackgroundChanged,
} from './background.js';

/** 窗口标识：Tauri 下由窗口 label（crop-main / crop-manager / crop-following）推断，浏览器预览时读 query */
function currentTarget() {
  try {
    const label = getCurrentWindow().label;
    if (label && label.startsWith('crop-')) return label.slice(5);
  } catch {
    /* 非 Tauri 环境 */
  }
  const fromQuery = new URLSearchParams(location.search).get('target');
  return BG_TARGETS[fromQuery] ? fromQuery : 'main';
}

const target = currentTarget();
const targetInfo = BG_TARGETS[target];
const { width: outW, height: outH } = outputSizeFor(target);

const stage = document.getElementById('crop-stage');
const canvas = document.getElementById('crop-canvas');
const frameEl = document.getElementById('crop-frame');
const emptyEl = document.getElementById('crop-empty');
const previewCanvas = document.getElementById('crop-preview-canvas');
const previewBox = document.querySelector('.crop-preview');
const zoomSlider = document.getElementById('crop-zoom');
const zoomValue = document.getElementById('crop-zoom-value');
const saveBtn = document.getElementById('btn-save');
const fileInput = document.getElementById('crop-file');

const ctx = canvas.getContext('2d');
const previewCtx = previewCanvas.getContext('2d');

/** 待裁剪的源图 */
let img = null;
/** 本次选中的原图（已按需缩小），保存时写入 IndexedDB；没换图就保持 null，不动已存的原图 */
let pendingSource = null;
/** 存原图前的长边上限：几千万像素的图没必要原样常驻内存和磁盘 */
const SOURCE_MAX_EDGE = 3000;
/** 取景框在舞台中的位置（CSS 像素），比例固定为目标窗口比例 */
const frame = { x: 0, y: 0, w: 0, h: 0 };
/** 图片在舞台中的位置与缩放：{x,y} 是图片左上角，scale = 图片像素 → CSS 像素 */
const view = { x: 0, y: 0, scale: 0, minScale: 0 };
let stageW = 1;
let stageH = 1;
let dpr = 1;
let rafId = 0;

/* ---------- 渲染 ---------- */

function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    drawStage();
    drawPreview();
  });
}

function drawStage() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0c16';
  ctx.fillRect(0, 0, stageW, stageH);
  if (!img) return;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, view.x, view.y, img.naturalWidth * view.scale, img.naturalHeight * view.scale);

  // 取景框之外压暗；框内保持原样，方便精确取景
  ctx.fillStyle = 'rgba(6, 8, 16, 0.72)';
  ctx.beginPath();
  ctx.rect(0, 0, stageW, stageH);
  ctx.rect(frame.x, frame.y, frame.w, frame.h);
  ctx.fill('evenodd');
}

/** 侧栏「窗口预览」：按目标窗口比例画出实际会显示的画面（含遮罩），用来看清文字对比度 */
function drawPreview() {
  const cssW = Math.max(40, previewBox ? previewBox.clientWidth : 200);
  const cssH = Math.max(1, Math.round((cssW * outH) / outW));
  previewCanvas.width = Math.round(cssW * dpr);
  previewCanvas.height = Math.round(cssH * dpr);
  previewCanvas.style.height = `${cssH}px`;

  previewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!img) {
    previewCtx.fillStyle = '#10131f';
    previewCtx.fillRect(0, 0, cssW, cssH);
    return;
  }
  previewCtx.imageSmoothingEnabled = true;
  previewCtx.imageSmoothingQuality = 'high';
  previewCtx.drawImage(
    img,
    (frame.x - view.x) / view.scale,
    (frame.y - view.y) / view.scale,
    frame.w / view.scale,
    frame.h / view.scale,
    0,
    0,
    cssW,
    cssH
  );
  previewCtx.fillStyle = `rgba(8, 10, 22, ${getScrim()})`;
  previewCtx.fillRect(0, 0, cssW, cssH);
}

/* ---------- 布局 ---------- */

/** 取景框最小可缩到「舞台适配尺寸」的比例；再小就没有可裁剪的意义了 */
const MIN_FRAME_SCALE = 0.25;

/** 取景框占「舞台适配尺寸」的比例，由拖把手调整；1 = 铺满舞台可容纳的最大尺寸 */
let frameScale = 1;
/** 舞台适配出来的最大取景框尺寸（比例固定 = 目标窗口比例） */
const fitFrame = { w: 0, h: 0 };
/** 图片恰好铺满「最大取景框」所需的缩放，作为缩放百分比 100% 的基准（与当前框大小无关） */
let fitCoverScale = 0;

/** 缩放上限：以「铺满最大取景框」的 MAX_ZOOM 倍为准，与当前框大小无关 */
function maxScale() {
  return fitCoverScale * MAX_ZOOM;
}

function measure() {
  const rect = stage.getBoundingClientRect();
  stageW = Math.max(1, rect.width);
  stageH = Math.max(1, rect.height);
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(stageW * dpr);
  canvas.height = Math.round(stageH * dpr);

  const pad = 24;
  const availW = Math.max(40, stageW - pad * 2);
  const availH = Math.max(40, stageH - pad * 2);
  const ar = outW / outH;
  let w = availW;
  let h = w / ar;
  if (h > availH) {
    h = availH;
    w = h * ar;
  }
  fitFrame.w = w;
  fitFrame.h = h;
  if (img) fitCoverScale = Math.max(w / img.naturalWidth, h / img.naturalHeight);

  applyFrameRect();
}

/** 由 fitFrame × frameScale 算出取景框（始终居中），并同步 DOM、缩放基准 */
function applyFrameRect() {
  frame.w = fitFrame.w * frameScale;
  frame.h = fitFrame.h * frameScale;
  frame.x = (stageW - frame.w) / 2;
  frame.y = (stageH - frame.h) / 2;

  frameEl.style.left = `${frame.x}px`;
  frameEl.style.top = `${frame.y}px`;
  frameEl.style.width = `${frame.w}px`;
  frameEl.style.height = `${frame.h}px`;

  if (img && fitCoverScale) {
    // 最小缩放 = 图片恰好铺满当前取景框；缩放范围的下限随框大小变化，上限固定
    view.minScale = Math.max(frame.w / img.naturalWidth, frame.h / img.naturalHeight);
    view.scale = Math.min(maxScale(), Math.max(view.minScale, view.scale));
  }
}

/** 拖把手改取景框大小：图片保持原位，只改框；框必须仍被图片完全覆盖 */
function setFrameScale(next) {
  frameScale = Math.min(maxFrameScaleForCoverage(), Math.max(MIN_FRAME_SCALE, next));
  applyFrameRect();
  clampView();
  syncZoomUi();
  scheduleRender();
}

/** 当前图片位置下，居中的取景框最多能长到多大（inside 图片矩形才会被完全覆盖） */
function maxFrameScaleForCoverage() {
  if (!img || !view.scale || !fitFrame.w) return MIN_FRAME_SCALE;
  const iw = img.naturalWidth * view.scale;
  const ih = img.naturalHeight * view.scale;
  const cx = stageW / 2;
  const cy = stageH / 2;
  const limitX = (2 * Math.min(cx - view.x, view.x + iw - cx)) / fitFrame.w;
  const limitY = (2 * Math.min(cy - view.y, view.y + ih - cy)) / fitFrame.h;
  return Math.max(MIN_FRAME_SCALE, Math.min(1, limitX, limitY));
}

/** 窗口尺寸变化后重算布局，并尽量保持用户已经调好的取景位置 */
function relayout() {
  let keep = null;
  if (img && view.scale > 0 && frame.w > 0 && fitCoverScale > 0) {
    keep = {
      cx: (frame.x + frame.w / 2 - view.x) / view.scale,
      cy: (frame.y + frame.h / 2 - view.y) / view.scale,
      rel: view.scale / fitCoverScale,
    };
  }
  measure();
  if (!img) return;

  if (keep) {
    view.scale = fitCoverScale * keep.rel;
    view.x = frame.x + frame.w / 2 - keep.cx * view.scale;
    view.y = frame.y + frame.h / 2 - keep.cy * view.scale;
  } else {
    view.scale = view.minScale;
    view.x = frame.x + (frame.w - img.naturalWidth * view.scale) / 2;
    view.y = frame.y + (frame.h - img.naturalHeight * view.scale) / 2;
  }
  clampView();
  syncZoomUi();
  scheduleRender();
}

/** 图片必须始终覆盖取景框，因此把位移夹在合法区间内 */
function clampView() {
  if (!img) return;
  const w = img.naturalWidth * view.scale;
  const h = img.naturalHeight * view.scale;
  if (w <= frame.w) view.x = frame.x + (frame.w - w) / 2;
  else view.x = Math.min(frame.x, Math.max(frame.x + frame.w - w, view.x));
  if (h <= frame.h) view.y = frame.y + (frame.h - h) / 2;
  else view.y = Math.min(frame.y, Math.max(frame.y + frame.h - h, view.y));
}

/** 缩放百分比以「铺满最大取景框」为 100%；滑杆下限随取景框变小而下移 */
function syncZoomUi() {
  if (!img || !fitCoverScale) return;
  const percent = Math.round((view.scale / fitCoverScale) * 100);
  const minPercent = Math.max(1, Math.round((view.minScale / fitCoverScale) * 100));
  zoomSlider.min = String(minPercent);
  zoomSlider.max = String(MAX_ZOOM * 100);
  zoomSlider.value = String(Math.min(MAX_ZOOM * 100, Math.max(minPercent, percent)));
  zoomValue.textContent = `${percent}%`;
}

/* ---------- 缩放 / 平移 ---------- */

/** 以 (anchorX, anchorY) 为锚点缩放到 nextScale，锚点下方的像素保持不动 */
function zoomTo(nextScale, anchorX, anchorY) {
  if (!img) return;
  const clamped = Math.min(maxScale(), Math.max(view.minScale, nextScale));
  if (clamped === view.scale) return;
  const k = clamped / view.scale;
  view.x = anchorX - (anchorX - view.x) * k;
  view.y = anchorY - (anchorY - view.y) * k;
  view.scale = clamped;
  clampView();
  syncZoomUi();
  scheduleRender();
}

function centerImage() {
  if (!img) return;
  view.x = frame.x + (frame.w - img.naturalWidth * view.scale) / 2;
  view.y = frame.y + (frame.h - img.naturalHeight * view.scale) / 2;
  clampView();
  scheduleRender();
}

/** 回到默认取景：取景框铺满，图片恰好铺满取景框并居中 */
function fitCover() {
  if (!img) return;
  frameScale = 1;
  applyFrameRect();
  view.scale = view.minScale;
  centerImage();
  syncZoomUi();
}

/* ---------- 图片 ---------- */

/** 图已解码好，设为当前源图并重置取景（换图后旧的位移/缩放是针对上一张图的像素，沿用会跑到图片外面） */
function useImage(image, restoreCrop = false) {
  img = image;
  view.scale = 0;
  frameScale = 1;
  frameEl.hidden = false;
  emptyEl.hidden = true;
  saveBtn.disabled = false;
  relayout();
  if (restoreCrop) applySavedCrop();
}

function loadFromUrl(url, restoreCrop = false) {
  const next = new Image();
  next.onload = () => useImage(next, restoreCrop);
  next.onerror = () => showToast('无法读取这张图片，请换一张试试');
  next.src = url;
}

/**
 * 当前取景框覆盖的原图范围，按原图宽高归一化（{u,v,w,h}）。
 * 只存比例、不存像素，所以裁剪窗口大小或显示器不同也能还原同一块区域；
 * `s` 是取景框自身的大小比例（同一块区域，框大框小看起来不一样）。
 */
function currentCropRect() {
  if (!img) return null;
  return {
    u: (frame.x - view.x) / view.scale / img.naturalWidth,
    v: (frame.y - view.y) / view.scale / img.naturalHeight,
    w: frame.w / view.scale / img.naturalWidth,
    h: frame.h / view.scale / img.naturalHeight,
    s: frameScale,
  };
}

/** 还原上次保存时的取景范围（框大小 + 图片缩放与位置），让重新打开时接着上次继续调整 */
function applySavedCrop() {
  const crop = getBackground(target)?.crop;
  if (!img || !crop) return;
  if (Number.isFinite(crop.s)) {
    frameScale = Math.min(1, Math.max(MIN_FRAME_SCALE, crop.s));
    applyFrameRect();
  }
  const sw = crop.w * img.naturalWidth;
  if (!(sw > 0)) return;
  view.scale = Math.min(maxScale(), Math.max(view.minScale, frame.w / sw));
  view.x = frame.x - crop.u * img.naturalWidth * view.scale;
  view.y = frame.y - crop.v * img.naturalHeight * view.scale;
  clampView();
  syncZoomUi();
  scheduleRender();
}

function pickFile() {
  fileInput.value = '';
  fileInput.click();
}

/** IndexedDB 里的原图 → data URL（CSP 只放行 data:，没放 blob:） */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** 入库前的原图：超过 3000px 长边就等比缩小重编码，否则原样保留（不重编码，质量零损失） */
async function prepareSource(image, file) {
  const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
  if (longEdge <= SOURCE_MAX_EDGE) return file;
  const k = SOURCE_MAX_EDGE / longEdge;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(image.naturalWidth * k));
  out.height = Math.max(1, Math.round(image.naturalHeight * k));
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(image, 0, 0, out.width, out.height);
  const blob = await new Promise(resolve => out.toBlob(resolve, 'image/jpeg', 0.9));
  return blob || file;
}

function onFileChosen(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    showToast('请选择图片文件');
    return;
  }
  if (file.size > 60 * 1024 * 1024) {
    showToast('图片过大（>60MB），请先压缩后再试');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result);
    const next = new Image();
    next.onload = async () => {
      // 先让用户看到图，再去处理入库用的原图（大图重编码要一会儿）
      useImage(next);
      try {
        pendingSource = await prepareSource(next, file);
      } catch (err) {
        console.warn('准备原图失败', err);
        pendingSource = file;
      }
    };
    next.onerror = () => showToast('无法读取这张图片，请换一张试试');
    next.src = dataUrl;
  };
  reader.onerror = () => showToast('读取图片失败');
  reader.readAsDataURL(file);
}

/* ---------- 保存 ---------- */

/** 按当前取景框渲染成 JPEG data URL */
function renderOutput(quality, scaleFactor) {
  const w = Math.max(1, Math.round(outW * scaleFactor));
  const h = Math.max(1, Math.round(outH * scaleFactor));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(
    img,
    (frame.x - view.x) / view.scale,
    (frame.y - view.y) / view.scale,
    frame.w / view.scale,
    frame.h / view.scale,
    0,
    0,
    w,
    h
  );
  return out.toDataURL('image/jpeg', quality);
}

async function save() {
  if (!img) return;
  saveBtn.disabled = true;

  // 换了新图就先把它存成「原图」，供下次重新裁剪；这一步失败不该挡住背景保存
  if (pendingSource) {
    try {
      await saveSource(target, pendingSource);
      pendingSource = null;
    } catch (err) {
      console.warn('保存背景原图失败', err);
    }
  }

  // 依次降级重试：localStorage 容量有限，超限时自动压缩
  const attempts = [
    [1, 0.8],
    [0.78, 0.62],
    [0.58, 0.5],
  ];
  let message = '背景保存失败';
  const crop = currentCropRect();
  for (const [scaleFactor, quality] of attempts) {
    const result = setBackground(target, renderOutput(quality, scaleFactor), crop);
    if (result.success) {
      await notifyBackgroundChanged();
      closeWindow();
      return;
    }
    message = result.message;
    if (!result.quota) break;
  }
  saveBtn.disabled = false;
  showToast(message);
}

/** 关窗：close() 被拒（权限配置漏了窗口 label）时也要给出兜底，别让窗口卡住 */
function closeWindow() {
  let pending = null;
  try {
    pending = getCurrentWindow().close();
  } catch {
    pending = null;
  }
  if (pending && typeof pending.catch === 'function') {
    pending.catch(err => {
      console.warn('关闭窗口失败', err);
      try {
        window.close();
      } catch {
        /* ignore */
      }
    });
  }
}

/* ---------- 提示 ---------- */

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

/* ---------- 交互绑定 ---------- */

/** 把手判定范围（CSS 像素）：角上给大一点，边缘窄一点 */
const CORNER_RADIUS = 22;
const EDGE_BAND = 10;

/** 指针位置换算到舞台坐标（与 frame / view 同一坐标系） */
function stagePoint(e) {
  const rect = stage.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/**
 * 命中判定：
 *   handle —— 取景框的角或边（长按拖动改变框大小，axis 指明按哪条边算）
 *   pan    —— 框内（拖动图片位置）
 *   none   —— 框外（不做任何响应，光标保持默认）
 */
function hitTest(p) {
  const { x: fx, y: fy, w: fw, h: fh } = frame;
  const corners = [
    { x: fx, y: fy, cursor: 'nwse-resize' },
    { x: fx + fw, y: fy, cursor: 'nesw-resize' },
    { x: fx, y: fy + fh, cursor: 'nesw-resize' },
    { x: fx + fw, y: fy + fh, cursor: 'nwse-resize' },
  ];
  for (const c of corners) {
    if (Math.hypot(p.x - c.x, p.y - c.y) <= CORNER_RADIUS) {
      return { type: 'handle', cursor: c.cursor, axis: 'both' };
    }
  }

  const inside = p.x >= fx && p.x <= fx + fw && p.y >= fy && p.y <= fy + fh;
  if (inside) {
    const toEdgeX = Math.min(p.x - fx, fx + fw - p.x);
    const toEdgeY = Math.min(p.y - fy, fy + fh - p.y);
    if (Math.min(toEdgeX, toEdgeY) <= EDGE_BAND) {
      const horizontal = toEdgeX < toEdgeY;
      return { type: 'handle', cursor: horizontal ? 'ew-resize' : 'ns-resize', axis: horizontal ? 'x' : 'y' };
    }
    return { type: 'pan' };
  }

  // 框外一点点也算把手，方便抓到边线
  const dx = Math.max(fx - p.x, p.x - (fx + fw), 0);
  const dy = Math.max(fy - p.y, p.y - (fy + fh), 0);
  if (Math.hypot(dx, dy) <= EDGE_BAND) {
    const horizontal = dx > dy;
    return { type: 'handle', cursor: horizontal ? 'ew-resize' : 'ns-resize', axis: horizontal ? 'x' : 'y' };
  }
  return { type: 'none' };
}

function bindPointer() {
  let dragging = false;
  /** 'pan' = 拖动图片；'frame' = 拖把手改取景框大小 */
  let mode = null;
  let lastX = 0;
  let lastY = 0;
  let axis = 'both';

  const frameCenter = () => ({ x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 });

  const syncCursor = (hit) => {
    // 拖动中光标由 pointerdown / endDrag 决定，这里只管悬停态
    if (dragging) return;
    canvas.style.cursor = hit.type === 'handle' ? hit.cursor : hit.type === 'pan' ? 'grab' : 'default';
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!img || e.button !== 0) return;
    const p = stagePoint(e);
    const hit = hitTest(p);
    if (hit.type === 'none') return;

    dragging = true;
    mode = hit.type === 'handle' ? 'frame' : 'pan';
    axis = hit.axis || 'both';
    canvas.style.cursor = hit.type === 'handle' ? hit.cursor : 'grabbing';
    lastX = e.clientX;
    lastY = e.clientY;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 指针已失效（例如合成事件）时忽略 */
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = stagePoint(e);
    if (!dragging) {
      syncCursor(hitTest(p));
      return;
    }
    if (mode === 'frame') {
      // 把手直接跟着指针走：角按到中心的距离算，边按到中心线的距离算，图片本身保持原位
      const c = frameCenter();
      let next;
      if (axis === 'x') next = Math.abs(p.x - c.x) / (fitFrame.w / 2);
      else if (axis === 'y') next = Math.abs(p.y - c.y) / (fitFrame.h / 2);
      else next = Math.hypot(p.x - c.x, p.y - c.y) / Math.hypot(fitFrame.w / 2, fitFrame.h / 2);
      setFrameScale(next);
      return;
    }
    view.x += e.clientX - lastX;
    view.y += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    clampView();
    scheduleRender();
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    mode = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    syncCursor(hitTest(stagePoint(e)));
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!img) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0016);
      zoomTo(view.scale * factor, e.clientX - rect.left, e.clientY - rect.top);
    },
    { passive: false }
  );
}

function bindControls() {
  document.getElementById('crop-target-name').textContent = targetInfo.label;
  document.getElementById('crop-target-meta').textContent =
    `窗口尺寸 ${targetInfo.width}×${targetInfo.height}`;

  document.getElementById('btn-pick').addEventListener('click', pickFile);
  document.getElementById('btn-pick-empty').addEventListener('click', pickFile);
  fileInput.addEventListener('change', () => onFileChosen(fileInput.files && fileInput.files[0]));

  zoomSlider.addEventListener('input', () => {
    if (!img || !fitCoverScale) return;
    const factor = Number(zoomSlider.value) / 100;
    zoomTo(fitCoverScale * factor, frame.x + frame.w / 2, frame.y + frame.h / 2);
  });

  document.getElementById('btn-fit').addEventListener('click', fitCover);
  document.getElementById('btn-center').addEventListener('click', centerImage);
  saveBtn.addEventListener('click', save);
  document.getElementById('btn-cancel').addEventListener('click', closeWindow);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeWindow();
    if (e.key === 'Enter' && !saveBtn.disabled) save();
  });

  const resizeObserver = new ResizeObserver(() => relayout());
  resizeObserver.observe(stage);
  // 侧栏宽度也会随窗口变化，预览画布要跟着重算背面尺寸，否则会被拉伸变形
  if (previewBox) resizeObserver.observe(previewBox);
  watchDevicePixelRatio();
}

/** 显示缩放比变化（把窗口拖到另一块不同缩放的显示器）时重算画布背面尺寸 */
function watchDevicePixelRatio() {
  if (!window.matchMedia) return;
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const onChange = () => {
    measure();
    if (img) clampView();
    syncZoomUi();
    scheduleRender();
    watchDevicePixelRatio();
  };
  if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange, { once: true });
  else if (typeof query.addListener === 'function') query.addListener(onChange);
}

async function init() {
  bindControls();
  bindPointer();
  measure();
  syncZoomUi();

  const existing = getBackground(target);

  // 优先取回上次选的原图：重新打开时应该看到整张图，而不是上一次裁剪后的结果
  let source = null;
  try {
    source = await loadSource(target);
  } catch (err) {
    console.warn('读取背景原图失败', err);
  }

  if (source) {
    try {
      // 有了原图才有办法回到上次的裁剪范围（大小 + 位置）
      loadFromUrl(await blobToDataUrl(source), true);
      scheduleRender();
      return;
    } catch (err) {
      console.warn('还原背景原图失败', err);
    }
  }
  if (existing) {
    loadFromUrl(existing.data);
  }
  scheduleRender();
}

init();
