/**
 * 主题：黑曜石 / 蓝锥矿 / 月光石 / 变石
 * - 这里只负责「选了哪套」和「变石怎么算色」；具体颜色写在 styles.css 的 html[data-theme=...] 里
 * - 选中的键存在 anime_cal_backgrounds.theme（和 scrim / blur 并列），这样跨窗口同步沿用同一套广播机制，
 *   读写由 src/background.js 负责，本模块不碰 localStorage
 */

export const DEFAULT_THEME = 'obsidian';

/** swatch 只用于设置页那个小圆点 */
export const THEMES = {
  obsidian: { label: '黑曜石', swatch: '#e8e2d6' },
  benitoite: { label: '蓝锥矿', swatch: '#3a79b8' },
  moonstone: { label: '月光石', swatch: '#c4557e' },
  alexandrite: { label: '变石', swatch: '#2e8c6c' },
};

/** 变石派生出来的变量，切走时要清掉 */
const DERIVED_VARS = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-card',
  '--bg-hover',
  '--border',
  '--accent',
  '--accent-light',
  '--accent-ink',
  '--today-marker',
  '--glass-fill',
  '--glass-fill-thick',
];

function clearDerived() {
  const root = document.documentElement;
  for (const key of DERIVED_VARS) root.style.removeProperty(key);
}

/** 变石但当前窗口没有背景图时调用：退回 CSS 里的兜底色 */
export function clearAlexandrite() {
  clearDerived();
}

/**
 * 把主题挂到 <html data-theme>，非变石的主题顺便清掉上一次变石算出来的内联变量。
 * @param {string} key
 * @returns {string} 实际生效的主题键
 */
export function applyTheme(key) {
  const name = THEMES[key] ? key : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', name);
  if (name !== 'alexandrite') clearDerived();
  return name;
}

/* ===== 变石：按背景图主色调算一套颜色 ===== */

/** @returns {[h(度), s(0-1), l(0-1)]} */
export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hsl(h, s, l, alpha) {
  const a = alpha === undefined ? 1 : alpha;
  return `hsla(${h.toFixed(0)}, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(0)}%, ${a})`;
}

/** 32×32 缩略图上取平均色；跳过近黑近白的像素，避免灰蒙蒙的照片把色相带偏 */
function sampleAverage(img) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const pr = data[i];
    const pg = data[i + 1];
    const pb = data[i + 2];
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    if (max < 24 || min > 240) continue; // 全黑 / 全白
    r += pr;
    g += pg;
    b += pb;
    n += 1;
  }
  if (!n) return [0, 0, 0.5];
  return [r / n, g / n, b / n];
}

/** 载入一张图片（data URL），失败返回 null */
export function loadImage(dataUrl) {
  return new Promise((resolve) => {
    if (!dataUrl) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * 变石的整窗调色：拿背景图主色调 → 取其近乎相反的方向当强调色。
 * 暖色照片配冷色宝石、冷色照片配暖色宝石，强调色在照片上永远跳得出来；
 * 石座和玻璃底色则染上一点照片自己的色相，所以整窗是「跟着背景变色」的。
 *
 * 这里给的是「全窗口一个色」的兜底值；真正贴在按钮上的颜色由 accent-field.js
 * 按每个按钮所处的背景位置各算一份，后面覆盖掉这里的 --accent。
 * @param {HTMLImageElement} img
 * @returns {boolean} 是否成功算出并应用
 */
export function applyAlexandritePalette(img) {
  if (!img) {
    clearDerived();
    return false;
  }
  try {
    const [r, g, b] = sampleAverage(img);
    const [hue, sat] = rgbToHsl(r, g, b);
    const shift = (hue + 165) % 360;
    const accentS = Math.min(0.62, Math.max(0.34, sat * 0.9 + 0.16));
    const tintS = Math.min(0.24, sat * 0.4);
    const root = document.documentElement;
    const set = (key, value) => root.style.setProperty(key, value);
    set('--bg-primary', hsl(hue, tintS * 0.8, 0.07));
    set('--bg-secondary', hsl(hue, tintS * 0.8, 0.1));
    set('--bg-card', hsl(hue, tintS * 0.7, 0.14));
    set('--bg-hover', hsl(hue, tintS * 0.7, 0.19));
    set('--border', hsl(hue, tintS * 0.6, 0.22));
    set('--accent', hsl(shift, accentS, 0.44));
    set('--accent-light', hsl(shift, accentS, 0.56));
    set('--accent-ink', '#ffffff');
    set('--today-marker', hsl(shift, accentS, 0.44));
    set('--glass-fill', hsl(hue, tintS, 0.09, 0.55));
    set('--glass-fill-thick', hsl(hue, tintS, 0.09, 0.82));
    return true;
  } catch (err) {
    console.warn('变石取色失败', err);
    clearDerived();
    return false;
  }
}

/** 主题选择按钮（设置页用），选中态由调用方按当前主题加 .active */
export function themeButtonHtml(list) {
  return list
    .map(
      ({ key, label, swatch, active }) => `<button type="button" class="theme-btn${active ? ' active' : ''}" data-theme-key="${key}">
      <span class="theme-dot" style="background:${swatch}"></span>
      <span class="theme-name">${label}</span>
    </button>`
    )
    .join('');
}
