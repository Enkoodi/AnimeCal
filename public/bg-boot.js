/**
 * 自定义背景的首屏应用脚本（普通同步脚本，必须放在 <head> 里、且在样式之后）。
 *
 * 为什么不写成 ES 模块：模块脚本是 defer 的，执行时浏览器可能已经先画了一帧默认底色，
 * 开子窗口时会看到明显的「先深蓝后图片」。这里在解析阶段同步跑完，第一帧就是最终效果。
 *
 * 页面通过 <script src="./bg-boot.js" data-bg-target="main"> 指定自己是哪个窗口。
 * 逻辑与 src/background.js 的 applyBackground 共用同一个入口：window.__applyStoredBackground。
 */
(function () {
  var KEY = 'anime_cal_backgrounds';
  var DEFAULT_SCRIM = 0.45;
  var DEFAULT_BLUR = 24;
  var MAX_BLUR = 30;   /* 与 src/background.js 的 MAX_BLUR 保持一致（首帧在这里贴，收不到那边的钳制） */
  var THEMES = ['obsidian', 'benitoite', 'moonstone', 'alexandrite'];
  var DEFAULT_THEME = 'obsidian';

  window.__applyStoredBackground = function (target) {
    var root = document.documentElement;
    var bg = null;
    var scrim = DEFAULT_SCRIM;
    var blur = DEFAULT_BLUR;
    var theme = DEFAULT_THEME;
    try {
      var store = JSON.parse(localStorage.getItem(KEY) || 'null') || {};
      scrim = typeof store.scrim === 'number' ? store.scrim : DEFAULT_SCRIM;
      blur = typeof store.blur === 'number' ? Math.min(MAX_BLUR, Math.max(0, store.blur)) : DEFAULT_BLUR;
      theme = THEMES.indexOf(store.theme) >= 0 ? store.theme : DEFAULT_THEME;
      bg = (store.windows || {})[target] || null;
    } catch (err) {
      bg = null;
    }

    // 主题先挂上：内联在解析阶段设好，第一帧就不会是「先默认主题再跳变」
    root.setAttribute('data-theme', theme);

    if (bg && bg.data) {
      root.style.setProperty('--window-bg-image', 'url("' + bg.data + '")');
      root.style.setProperty('--bg-scrim', String(scrim));
      root.style.setProperty('--glass-blur', blur + 'px');
      root.classList.add('has-custom-bg');
    } else {
      root.classList.remove('has-custom-bg');
      root.style.removeProperty('--window-bg-image');
      root.style.removeProperty('--glass-blur');
    }
  };

  var self = document.currentScript;
  var target = (self && self.dataset && self.dataset.bgTarget) || 'main';
  window.__applyStoredBackground(target);
})();
