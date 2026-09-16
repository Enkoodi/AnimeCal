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

  window.__applyStoredBackground = function (target) {
    var root = document.documentElement;
    var bg = null;
    var scrim = DEFAULT_SCRIM;
    try {
      var store = JSON.parse(localStorage.getItem(KEY) || 'null') || {};
      scrim = typeof store.scrim === 'number' ? store.scrim : DEFAULT_SCRIM;
      bg = (store.windows || {})[target] || null;
    } catch (err) {
      bg = null;
    }

    if (bg && bg.data) {
      root.style.setProperty('--window-bg-image', 'url("' + bg.data + '")');
      root.style.setProperty('--bg-scrim', String(scrim));
      root.classList.add('has-custom-bg');
    } else {
      root.classList.remove('has-custom-bg');
      root.style.removeProperty('--window-bg-image');
    }
  };

  var self = document.currentScript;
  var target = (self && self.dataset && self.dataset.bgTarget) || 'main';
  window.__applyStoredBackground(target);
})();
