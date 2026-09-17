/**
 * 变石主题：按位置取色（accent field）
 *
 * 只负责算色并把颜色写成元素上的 CSS 变量（--accent / --accent-light / --accent-deep / --accent-ink）；
 * 渐变与悬停的观感在 styles.css 里（内联的 background-image 会盖掉 :hover 变色，所以不能在这边写）。
 *
 * 把窗口切成若干「像素组」（默认 44px 见方），每组从它背后那块背景像素算一个强调色，
 * 按钮落在哪组就用哪组的颜色 —— 同一屏里每个按钮各不相同，颜色是背景的函数。
 * 只算一次（切到变石 / 换背景图 / 换窗口尺寸），之后拉窗口不会重算，颜色保持不变。
 *
 * 坐标映射：背景按 cover 铺满窗口（见 styles.css 的 html.has-custom-bg），
 * 所以「窗口坐标 → 原图坐标」要先还原 cover 的实际绘制矩形；
 * 文档本身不滚动（body overflow:hidden），getBoundingClientRect() 拿到的就是最终落点。
 * 取色用的是相对坐标（百分比），所以窗口变了也不会取错组。
 */
import { loadImage, rgbToHsl } from './theme.js';

/** 一组像素多大（CSS px）。44 ≈ 主窗口 9×11 组、添加番剧窗口 17×15 组 */
const CELL = 44;
/** 每组内部再采 8×8 个点求平均，避免单点噪声 */
const SUB = 8;
const MAX_GROUPS = 40;
/** 原图先缩到这个尺寸再采可见区域，一次跳过大的降采样会把颜色采偏 */
const MID_MAX_EDGE = 720;

/**
 * 会被按位置染色的元素：所有「强调色表面」（按钮、选中态、滑杆滑块…）。
 * 加新按钮时把类名加进来，否则它会退回整窗一个色的兜底强调色。
 */
const PAINT_SELECTOR = [
  '.action-btn',
  '.dialog-btn-danger',
  '.chip.active',
  '.tab-btn.active',
  '.icon-btn.active',
  '.icon-btn.pinned',
  '.day-cell.today',
  '.rating-num.selected',
  '.rating-num.in-range',
  '.unfollow-btn',
  '.follow-clear-btn',
  '.season-tag',
  '.theme-btn.active',
  'input[type="range"]',
  '.toggle-label input[type="checkbox"]:checked',
].join(', ');


const STYLE_PROPS = ['--accent', '--accent-light', '--accent-deep', '--accent-ink', '--today-marker'];

let state = null;
/** 曾经被上过色的所有元素。⚠️ 只增不减（只清理已从 DOM 摘掉的），
    因为元素一旦被隐藏（视图切走、tab 切换）就不再出现在可见集合里，
    要是那时把它忘掉，它身上残留的内联变量就永远清不掉 —— 换主题时会留着变石的颜色。 */
let touched = new Set();
/** 本次色场里已经「定过色」的元素：定了就不再重算。
    ⚠️ 关键：颜色按位置算，而位置会变（列表渲染完把按钮推下去、滚动、选中态改变布局），
    每次重绘都重算的话，用户点一下按钮颜色就变了 —— 用户要的是「算一次，之后不变」。 */
let assigned = new Set();
let observer = null;
let timer = 0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 摘掉某个元素上由本模块写的内联值，让它回到 CSS 里的状态样式 */
function unpaint(el) {
  for (const prop of STYLE_PROPS) el.style.removeProperty(prop);
}

function hsla(h, s, l, a) {
  const alpha = a === undefined ? 1 : a;
  return `hsla(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${alpha})`;
}

/** 相对亮度（HSL → RGB），用来决定配白字还是深字 */
function relLum(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const f = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r + m) + 0.7152 * f(g + m) + 0.0722 * f(b + m);
}

/**
 * 一组背景像素 → 一个强调色。
 * - 色相取反（背景暖 → 按钮冷），这是「变石」的核心
 * - 饱和度跟着局部像素的艳度走
 * - 明度与背景反着走：背景越亮，按钮越深；背景越暗，按钮越亮 ——
 *   既保证按钮在照片上读得出来，也让「亮处的按钮」和「暗处的按钮」拉开距离
 *   （同色相的壁纸上，这是唯一能让每个按钮看出区别的维度）
 */
function derive(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  const hue = (h + 165) % 360;
  const sat = clamp(0.34 + s * 0.46, 0.34, 0.76);
  const lig = clamp(0.5 + (0.5 - l) * 0.42, 0.32, 0.62);
  const lightL = Math.min(0.72, lig + 0.12);
  const deepL = Math.max(0.2, lig - 0.14);
  return {
    mid: hsla(hue, sat, lig),
    light: hsla(hue, Math.min(0.88, sat + 0.08), lightL),
    deep: hsla(hue, sat, deepL),
    // 阈值偏早（0.32）：偏亮的按钮改用深字，否则白字在浅色按钮上会发飘
    ink: relLum(hue, sat, lig) > 0.32 ? 'rgba(18, 16, 14, 0.92)' : 'rgba(255, 255, 255, 0.95)',
  };
}

/** 背景以 cover 铺满窗口时，窗口可视区域对应原图上的哪一块 */
function coverRect(iw, ih, w, h) {
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  return {
    sx: (dw - w) / 2 / scale,
    sy: (dh - h) / 2 / scale,
    sw: w / scale,
    sh: h / scale,
  };
}

/**
 * 算出整张「色场」：cols×rows 组，每组一个颜色。
 * @param {HTMLImageElement} img 背景图
 * @param {number} width 计算时的窗口宽（CSS px）
 * @param {number} height 计算时的窗口高
 */
function buildField(img, width, height) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih || !width || !height) return null;
  const cols = clamp(Math.round(width / CELL), 3, MAX_GROUPS);
  const rows = clamp(Math.round(height / CELL), 3, MAX_GROUPS);
  const r = coverRect(iw, ih, width, height);

  const mScale = Math.min(1, MID_MAX_EDGE / Math.max(iw, ih));
  const mid = document.createElement('canvas');
  mid.width = Math.max(1, Math.round(iw * mScale));
  mid.height = Math.max(1, Math.round(ih * mScale));
  const mctx = mid.getContext('2d', { willReadFrequently: true });
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(img, 0, 0, mid.width, mid.height);

  const canvas = document.createElement('canvas');
  canvas.width = cols * SUB;
  canvas.height = rows * SUB;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    mid,
    r.sx * mScale,
    r.sy * mScale,
    r.sw * mScale,
    r.sh * mScale,
    0,
    0,
    canvas.width,
    canvas.height
  );
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  const cells = new Array(cols * rows);
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      let r1 = 0;
      let g1 = 0;
      let b1 = 0;
      let n1 = 0;
      let r2 = 0;
      let g2 = 0;
      let b2 = 0;
      let n2 = 0;
      for (let y = 0; y < SUB; y += 1) {
        for (let x = 0; x < SUB; x += 1) {
          const i = ((cy * SUB + y) * canvas.width + (cx * SUB + x)) * 4;
          const pr = px[i];
          const pg = px[i + 1];
          const pb = px[i + 2];
          r2 += pr;
          g2 += pg;
          b2 += pb;
          n2 += 1;
          // 近黑 / 近白的像素没有色相，会把这组的色相带偏，先剔掉
          if (Math.max(pr, pg, pb) < 26 || Math.min(pr, pg, pb) > 238) continue;
          r1 += pr;
          g1 += pg;
          b1 += pb;
          n1 += 1;
        }
      }
      const use = n1 > n2 * 0.15 ? [r1 / n1, g1 / n1, b1 / n1] : [r2 / n2, g2 / n2, b2 / n2];
      cells[cy * cols + cx] = derive(use[0], use[1], use[2]);
    }
  }
  return { cols, rows, cells, width, height };
}

/** 元素中心落在第几组（用相对位置，窗口变了也不会取错） */
function cellAt(field, x, y) {
  const cx = clamp(Math.floor((x / field.width) * field.cols), 0, field.cols - 1);
  const cy = clamp(Math.floor((y / field.height) * field.rows), 0, field.rows - 1);
  return field.cells[cy * field.cols + cx] || null;
}

/**
 * 给当前 DOM 里所有强调色表面重新上色。
 * 三件事，顺序不能反：
 * 1. 掉出选择器的（取消选中、换状态）先摘掉内联值 —— 否则「已取消选中」的 chip
 *    还留着渐变和强调色，看起来仍是选中状态；
 * 2. 本次色场里已经定过色的元素直接跳过 —— 位置再变也不改色（点按钮、切 tab、滚动都别动它）；
 * 3. 剩下的（新出现的 / 刚显示的 / 换了色场）按当前位置定色。
 */
function paintAll() {
  if (!state) return;
  const matched = new Set(document.querySelectorAll(PAINT_SELECTOR));
  for (const el of Array.from(touched)) {
    if (!el.isConnected) {
      touched.delete(el);
      assigned.delete(el);
      continue;
    }
    if (!matched.has(el)) {
      unpaint(el);
      touched.delete(el);
      assigned.delete(el);
    }
  }
  const jobs = [];
  for (const el of matched) {
    if (assigned.has(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue; // 还藏着，等它显示出来再定
    jobs.push([el, rect]);
  }
  for (const [el, rect] of jobs) {
    // 取按钮内部两个对角取样点：小的按钮落在同一组，大按钮跨组 → 渐变两端来自不同位置
    const a = cellAt(state, rect.left + rect.width * 0.2, rect.top + rect.height * 0.2);
    const b = cellAt(state, rect.right - rect.width * 0.2, rect.bottom - rect.height * 0.2);
    if (!a) continue;
    el.style.setProperty('--accent', a.mid);
    el.style.setProperty('--today-marker', a.mid);
    el.style.setProperty('--accent-light', a.light);
    el.style.setProperty('--accent-deep', (b || a).deep);
    el.style.setProperty('--accent-ink', a.ink);
    touched.add(el);
    assigned.add(el);
  }
}

function schedule() {
  if (timer || !state) return;
  timer = setTimeout(() => {
    timer = 0;
    paintAll();
  }, 60);
}

/**
 * 列表是整块重绘的，新元素要补色；只监听结构变化，写 style 不会触发自己。
 * 还要盯 class：主窗口的三个视图是靠切 `.active` 显示/隐藏的，隐藏时元素尺寸为 0 会被跳过，
 * 切过去的那一刻必须补上色（否则那些按钮会一直是整窗兜底色）。
 */
function watch() {
  if (observer || typeof MutationObserver !== 'function' || !document.body) return;
  observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
}

/** 擦掉所有按位置算出来的颜色，回到「整窗一个强调色」 */
export function clearAccentField() {
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  for (const el of touched) unpaint(el);
  touched = new Set();
  assigned = new Set();
  state = null;
}

/**
 * 算一次色场并铺到当前界面上。
 * @param {string|HTMLImageElement} source 背景图（data URL 或已载入的 Image）
 * @param {string} [id] 缓存键；同一个键不会重算（换主题 / 换图 / 换窗口尺寸才会变）
 * @returns {Promise<boolean>}
 */
export async function applyAccentField(source, id) {
  const size = {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  };
  const key = id || `${size.width}x${size.height}|${String(source).length}`;
  if (state && state.id === key) return true;
  const img = typeof source === 'string' ? await loadImage(source) : source;
  if (!img) {
    clearAccentField();
    return false;
  }
  const field = buildField(img, size.width, size.height);
  if (!field) {
    clearAccentField();
    return false;
  }
  clearAccentField();
  state = { ...field, id: key };
  paintAll();
  watch();
  return true;
}
