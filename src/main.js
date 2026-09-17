/**
 * 应用主逻辑（主日历窗口）
 */
import { Calendar } from './calendar.js';
import * as AnimeStore from './anime.js';
import * as BangumiAPI from './bangumi.js';
import { deleteSource } from './bg-store.js';
import {
  BG_TARGETS,
  applyBackground,
  getBackground,
  getBlur,
  getScrim,
  getTheme,
  initBackground,
  notifyBackgroundChanged,
  openCropWindow,
  removeBackground,
  setBlur,
  setScrim,
  setTheme,
} from './background.js';
import { THEMES, themeButtonHtml } from './theme.js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
let calendar = null;
let currentView = 'calendar';
let currentDetailDate = null;

/**
 * 「自动更新番剧信息」的检查间隔：距上次成功刷新不足该时长则跳过，避免每次启动都打 Bangumi。
 * 番剧的播出区间/集数变化很慢，一周一次足够；等不及的用户可以随时点「手动刷新信息」。
 */
const AUTO_UPDATE_TTL = 7 * 24 * 60 * 60 * 1000;

function getTauriWindow() {
  try {
    return getCurrentWindow();
  } catch (err) {
    return null;
  }
}

/**
 * 通过 Rust 后端向所有窗口广播数据变化事件。
 * 子窗口直接 emit 的 Tauri 事件只在本窗口内传播，主窗口收不到；
 * 必须经由 Rust 广播，才能让 main / manager / following 任意窗口都刷新 UI。
 */
async function broadcastDataChanged() {
  try {
    await invoke('notify_all_windows');
  } catch (err) {
    console.warn('notify_all_windows failed', err);
  }
}

// 兼容性导出：manager / following 窗口会通过 import 使用此函数
export { broadcastDataChanged };

function switchView(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`${viewName}-view`).classList.add('active');
  currentView = viewName;
}

function showToast(message, duration = 2000) {
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

function refreshMainUi() {
  calendar?.render();
  refreshMyAnimeTags();
  if (currentDetailDate && currentView === 'detail') {
    showAnimeDetail(currentDetailDate);
  }
}

function initCalendar() {
  calendar = new Calendar('calendar-grid', {
    onDateClick: (date) => showAnimeDetail(date),
  });
  document.getElementById('prev-month').addEventListener('click', () => calendar.prevMonth());
  document.getElementById('next-month').addEventListener('click', () => calendar.nextMonth());
  document.getElementById('month-year').addEventListener('dblclick', () => calendar.goToToday());
}

function showAnimeDetail(date) {
  currentDetailDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dateStr = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  document.getElementById('detail-date').textContent = `${dateStr} ${weekdayNames[date.getDay()]}`;

  const animeList = AnimeStore.getAnimeForDate(date);
  const container = document.getElementById('anime-list');

  if (animeList.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">TV</div>这天没有关注的番剧更新</div>`;
  } else {
    const fallbackCover = 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="64"><rect fill="#0f3460" width="48" height="64"/><text fill="#666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="10">暂无</text></svg>`
    );
    container.innerHTML = animeList.map(item => `
      <div class="anime-item ${item.watched ? 'watched' : ''}" data-id="${item.id}" data-ep="${item.episode}" title="${item.watched ? '点击标记为未看' : '点击标记为已看'}">
        <img class="anime-cover" src="${item.cover || fallbackCover}" alt="${item.name}" onerror="this.src='${fallbackCover}'"/>
        <div class="anime-info">
          <div class="anime-title">${item.name}</div>
          ${item.airTime ? `<div class="anime-time">${item.airTime}</div>` : ''}
          <div class="anime-episode">${item.label}${item.totalEpisodes ? ` / ${item.totalEpisodes}` : ''}</div>
          ${item.watched ? '<div class="anime-watched-hint">已看</div>' : '<div class="anime-edit-hint">点击标记为已看</div>'}
        </div>
        ${item.watched ? '<span class="watched-badge">✓</span>' : ''}
      </div>
    `).join('');

    container.querySelectorAll('.anime-item').forEach(el => {
      el.addEventListener('click', () => {
        AnimeStore.toggleEpisodeWatched(el.dataset.id, el.dataset.ep);
        refreshMainUi();
      });
    });
  }
  switchView('detail');
}

/** 打开独立的「添加番剧」大窗口。由 Rust 后端创建，保证 data_directory 与主窗口一致。 */
async function openManagerWindow() {
  // 浏览器预览兜底（无 Tauri 环境时）
  if (!window.__TAURI__) {
    window.open('./manager.html', 'anime-manager', 'width=760,height=680');
    return;
  }

  try {
    await invoke('open_manager_window');
  } catch (err) {
    console.error('open_manager_window failed', err);
    showToast('无法打开添加番剧窗口');
  }
}

/** 打开「管理番剧」窗口：只显示我已追的番剧，可取消追番并按集标记状态。由 Rust 后端创建，保证 data_directory 与主窗口一致。 */
async function openFollowingWindow() {
  // 浏览器预览兜底（无 Tauri 环境时）
  if (!window.__TAURI__) {
    window.open('./following.html', 'anime-following', 'width=460,height=600');
    return;
  }

  try {
    await invoke('open_following_window');
  } catch (err) {
    console.error('open_following_window failed', err);
    showToast('无法打开管理番剧窗口');
  }
}

function initSettings() {
  const settings = AnimeStore.getSettings();
  document.getElementById('auto-update').checked = settings.autoUpdate;
  document.getElementById('always-on-top').checked = settings.alwaysOnTop;
  document.getElementById('start-minimized').checked = settings.startMinimized;
  document.getElementById('close-to-tray').checked = settings.closeToTray;
  refreshMyAnimeTags();
  refreshThemeButtons();
  refreshBackgroundRows();
  syncBackgroundControls();
  updateAutoUpdateHint();
  syncPinButton(settings.alwaysOnTop);
}

/* ===== 个性化：自定义背景 ===== */

/** 主题选择：四套配色，选中态写回 localStorage 后广播给其它窗口 */
function refreshThemeButtons() {
  const container = document.getElementById('theme-grid');
  if (!container) return;
  const current = getTheme();
  container.innerHTML = themeButtonHtml(
    Object.entries(THEMES).map(([key, info]) => ({
      key,
      label: info.label,
      swatch: info.swatch,
      active: key === current,
    }))
  );
}

/** 渲染三个窗口的背景缩略图；点整行进入该窗口的裁剪界面，点 × 移除 */
function refreshBackgroundRows() {
  const container = document.getElementById('bg-rows');
  if (!container) return;
  container.innerHTML = Object.entries(BG_TARGETS).map(([key, info]) => {
    const bg = getBackground(key);
    // 缩略图按各窗口自己的比例画，一眼能看出主窗口是竖的、添加番剧是横的
    const thumbWidth = Math.round((52 * info.width) / info.height);
    return `<div class="bg-row" data-target="${key}" title="${bg ? '点击重新裁剪' : '点击选择图片'}">
      <div class="bg-row-thumb" style="width:${thumbWidth}px">${bg ? `<img src="${bg.data}" alt="" />` : '&#43;'}</div>
      <div class="bg-row-info">
        <div class="bg-row-name">${info.label}</div>
        <div class="bg-row-sub">${bg ? '已设置' : '未设置'} · ${info.width}×${info.height}</div>
      </div>
      <div class="bg-row-actions">${bg ? '<button type="button" class="bg-mini-btn" data-act="clear" title="移除背景">&times;</button>' : ''}</div>
    </div>`;
  }).join('');
}

/** 遮罩浓度（0-80%）与玻璃模糊度（0-60px）两个滑杆：拖动时实时预览，松手后写入并广播给其它窗口 */
function syncBackgroundControls() {
  const scrim = document.getElementById('bg-scrim');
  if (scrim) {
    const percent = Math.round(getScrim() * 100);
    scrim.value = String(percent);
    document.getElementById('bg-scrim-value').textContent = `${percent}%`;
  }
  const blur = document.getElementById('bg-blur');
  if (blur) {
    const px = Math.round(getBlur());
    blur.value = String(px);
    document.getElementById('bg-blur-value').textContent = `${px}px`;
  }
}

async function clearBackgroundFor(target) {
  const result = removeBackground(target);
  if (!result.success) {
    showToast(result.message);
    return;
  }
  // 连原图一起清掉：留着它下次打开裁剪窗口还会看到一张已经用不上的旧图
  try {
    await deleteSource(target);
  } catch (err) {
    console.warn('删除背景原图失败', err);
  }
  // 本窗口自己不会收到自己的广播，需要手动重绘
  applyBackground('main');
  await notifyBackgroundChanged();
  refreshBackgroundRows();
  showToast(`已移除「${BG_TARGETS[target]?.label || ''}」的背景`);
}

async function onBackgroundChangedFromElsewhere() {
  refreshThemeButtons();
  refreshBackgroundRows();
  syncBackgroundControls();
}

async function syncCloseToTray(value) {
  try {
    await invoke('set_close_to_tray', { value });
  } catch (err) {
    console.warn('syncCloseToTray failed', err);
  }
}

/** 置顶按钮：图标是同一枚 SVG（换形状会和其它三个按钮不统一），
    两种状态只靠按钮底色（.pinned 的强调色底）与图标不透明度区分，见 styles.css */
function syncPinButton(pinned) {
  const btn = document.getElementById('btn-toggle-pin');
  const on = !!pinned;
  btn.classList.toggle('active', on);
  btn.classList.toggle('pinned', on);
  btn.title = on ? '已置顶（点击取消）' : '未置顶（点击置顶）';
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  document.getElementById('always-on-top').checked = on;
}

function refreshMyAnimeTags() {
  const myAnime = AnimeStore.getMyAnime();
  const container = document.getElementById('my-anime-list');
  if (!container) return;
  if (myAnime.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:12px;">暂无关注的番剧</span>';
    return;
  }
  container.innerHTML = myAnime.map(anime =>
    `<span class="my-anime-tag" data-id="${anime.id}">${anime.name}<span class="remove-tag" data-id="${anime.id}">&times;</span></span>`
  ).join('');
  container.querySelectorAll('.remove-tag').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const result = AnimeStore.removeMyAnime(btn.dataset.id);
      if (result.success) {
        showToast(`已移除《${result.anime?.name || ''}》`);
        refreshMainUi();
      }
    });
  });
}

async function setAlwaysOnTop(pinned) {
  AnimeStore.updateSettings({ alwaysOnTop: pinned });
  syncPinButton(pinned);
  const win = getTauriWindow();
  if (win) {
    try {
      await win.setAlwaysOnTop(pinned);
    } catch (err) {
      console.warn('setAlwaysOnTop failed', err);
    }
  }
}

function bindEvents() {
  document.getElementById('btn-back').addEventListener('click', () => switchView('calendar'));
  document.getElementById('btn-back-settings').addEventListener('click', () => switchView('calendar'));
  document.getElementById('btn-settings').addEventListener('click', () => {
    initSettings();
    switchView('settings');
  });
  document.getElementById('btn-manage-anime').addEventListener('click', () => openManagerWindow());
  document.getElementById('btn-following').addEventListener('click', () => openFollowingWindow());
  document.getElementById('btn-add-anime').addEventListener('click', () => openManagerWindow());
  document.getElementById('btn-fetch-bangumi').addEventListener('click', () => manualRefreshAnimeInfo());

  // 「个性化」：点行进入裁剪窗口、点 × 移除；遮罩滑杆即时预览
  document.getElementById('bg-rows').addEventListener('click', (e) => {
    const row = e.target.closest('.bg-row');
    if (!row) return;
    const target = row.dataset.target;
    if (e.target.closest('[data-act="clear"]')) {
      clearBackgroundFor(target);
      return;
    }
    openCropWindow(target);
  });

  document.getElementById('theme-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('.theme-btn');
    if (!btn) return;
    const key = btn.dataset.themeKey;
    if (!THEMES[key] || key === getTheme()) return;
    setTheme(key);
    applyBackground('main');
    await notifyBackgroundChanged();
    refreshThemeButtons();
  });

  const scrimSlider = document.getElementById('bg-scrim');
  scrimSlider.addEventListener('input', (e) => {
    const percent = Number(e.target.value);
    document.getElementById('bg-scrim-value').textContent = `${percent}%`;
    document.documentElement.style.setProperty('--bg-scrim', String(percent / 100));
  });
  scrimSlider.addEventListener('change', async () => {
    const percent = Number(scrimSlider.value);
    setScrim(percent / 100);
    applyBackground('main');
    await notifyBackgroundChanged();
  });

  const blurSlider = document.getElementById('bg-blur');
  blurSlider.addEventListener('input', (e) => {
    const px = Number(e.target.value);
    document.getElementById('bg-blur-value').textContent = `${px}px`;
    document.documentElement.style.setProperty('--glass-blur', `${px}px`);
  });
  blurSlider.addEventListener('change', async () => {
    setBlur(Number(blurSlider.value));
    applyBackground('main');
    await notifyBackgroundChanged();
  });

  document.getElementById('auto-update').addEventListener('change', async (e) => {
    AnimeStore.updateSettings({ autoUpdate: e.target.checked });
    const result = await tryAutoUpdate(true);
    const messages = {
      fresh: '番剧信息已是最新',
      ok: '番剧信息已更新',
      fail: '刷新失败，请检查网络连接',
    };
    if (messages[result]) showToast(messages[result]);
    else if (result === 'disabled') showToast('已关闭自动更新');
  });
  document.getElementById('always-on-top').addEventListener('change', (e) => {
    setAlwaysOnTop(e.target.checked);
  });
  document.getElementById('start-minimized').addEventListener('change', (e) => {
    AnimeStore.updateSettings({ startMinimized: e.target.checked });
  });
  document.getElementById('close-to-tray').addEventListener('change', (e) => {
    const value = e.target.checked;
    AnimeStore.updateSettings({ closeToTray: value });
    syncCloseToTray(value);
  });

  document.getElementById('btn-minimize').addEventListener('click', async () => {
    const win = getTauriWindow();
    if (win) await win.hide();
  });
  document.getElementById('btn-close').addEventListener('click', async () => {
    const win = getTauriWindow();
    if (win) await win.close();
  });
  document.getElementById('btn-toggle-pin').addEventListener('click', () => {
    const pinned = document.getElementById('btn-toggle-pin').classList.contains('active');
    setAlwaysOnTop(!pinned);
  });
}

/** 标题栏：用 startDragging 保证可拖动（data-tauri-drag-region 在部分 WebView2 上无效） */
function initWindowDragging() {
  const tryStartDrag = async (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.no-drag, button, input, select, a, .icon-btn, .nav-btn, .day-cell, .action-btn')) {
      return;
    }
    const region = e.target.closest('[data-tauri-drag-region]');
    if (!region) return;
    const win = getTauriWindow();
    if (!win?.startDragging) return;
    try {
      await win.startDragging();
    } catch (err) {
      console.warn('startDragging failed', err);
    }
  };

  document.addEventListener('mousedown', tryStartDrag);
}

async function applyStartupSettings() {
  const settings = AnimeStore.getSettings();
  await setAlwaysOnTop(settings.alwaysOnTop !== false);
  await syncCloseToTray(settings.closeToTray === true);
  if (settings.startMinimized) {
    const win = getTauriWindow();
    if (win) {
      try {
        await win.hide();
      } catch (err) {
        console.warn('startMinimized hide failed', err);
      }
    }
  }
}

async function backfillMissingAirRanges() {
  const list = AnimeStore.getMyAnime().filter(
    a => a.bangumiId &&
      (!a.startDate || !a.endDate || !a.totalEpisodes || !a.episodeDates || a.episodeDates.length === 0)
  );
  if (!list.length) return;
  showToast(`正在补全 ${list.length} 部番剧的播出时间...`, 3000);
  for (const anime of list) {
    try {
      const detail = await BangumiAPI.getSubjectDetail(anime.bangumiId);
      AnimeStore.backfillAirRange(anime.id, detail);
    } catch (err) {
      console.warn('补全播出区间失败', anime.name, err);
    }
  }
  refreshMainUi();
  showToast('播出时间已更新');
}

/**
 * 刷新所有已追番剧的播出信息（Bangumi 详情 → 本地播出区间/集数/时刻）。
 * 只要有任意一部成功，就更新 lastFetch 时间戳，作为自动更新的计时基准。
 * @param {boolean} silent 静默模式：不提示进度，用于开机自动更新
 * @returns {Promise<number>} 成功刷新的番剧数量
 */
async function refreshAllAnimeInfo({ silent = false } = {}) {
  const list = AnimeStore.getMyAnime().filter(a => a.bangumiId);
  if (!list.length) return 0;
  if (!silent) showToast(`正在刷新 ${list.length} 部番剧信息...`, 3500);
  let ok = 0;
  for (const anime of list) {
    try {
      const detail = await BangumiAPI.getSubjectDetail(anime.bangumiId);
      AnimeStore.backfillAirRange(anime.id, detail);
      ok++;
    } catch (err) {
      console.warn('刷新番剧信息失败', anime.name, err);
    }
  }
  if (ok > 0) {
    AnimeStore.setLastFetch();
    refreshMainUi();
  }
  return ok;
}

/** 手动刷新：强制从 Bangumi 重新拉取所有已追番剧的最新播出/集数信息 */
async function manualRefreshAnimeInfo() {
  const list = AnimeStore.getMyAnime().filter(a => a.bangumiId);
  if (!list.length) {
    showToast('暂无已追番剧可刷新');
    return;
  }
  const ok = await refreshAllAnimeInfo();
  updateAutoUpdateHint();
  showToast(ok > 0 ? `已更新 ${ok} 部番剧信息` : '刷新失败，请检查网络连接');
}

/**
 * 自动更新流程：「自动更新番剧信息」开关开启，且距上次刷新超过 AUTO_UPDATE_TTL 时才真正联网。
 * @param {boolean} interactive 由用户手动开启开关触发时为 true：非静默刷新，让用户看到反馈
 * @returns {Promise<'disabled'|'fresh'|'ok'|'fail'>}
 */
async function tryAutoUpdate(interactive = false) {
  if (!AnimeStore.getSettings().autoUpdate) return 'disabled';
  const last = AnimeStore.getLastFetch();
  if (last && Date.now() - last < AUTO_UPDATE_TTL) return 'fresh';
  const ok = await refreshAllAnimeInfo({ silent: !interactive });
  updateAutoUpdateHint();
  return ok > 0 ? 'ok' : 'fail';
}

/** 把「上次更新」渲染到设置界面，让开关的实际效果可见（只显示状态，不写机制说明） */
function updateAutoUpdateHint() {
  const el = document.getElementById('auto-update-hint');
  if (!el) return;
  const last = AnimeStore.getLastFetch();
  el.textContent = last ? `上次更新：${formatRelativeTime(last)}` : '尚未更新过';
}

/** 时间戳 → 「刚刚 / 3 小时前 / 2 天前 / 具体日期」 */
function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 3600 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function listenExternalUpdates() {
  try {
    await window.__TAURI__?.event?.listen?.('anime-data-changed', () => {
      refreshMainUi();
      showToast('番剧列表已更新');
    });
  } catch (err) {
    console.warn('listen anime-data-changed failed', err);
  }
  window.addEventListener('storage', (e) => {
    if (e.key === 'anime_cal_ping' || e.key === 'anime_cal_data') {
      refreshMainUi();
      showToast('番剧列表已更新');
    }
  });
}

async function init() {
  initCalendar();
  bindEvents();
  initWindowDragging();
  // 背景先应用：裁剪窗口保存后会广播 background-changed，这里同步刷新缩略图
  initBackground('main', onBackgroundChangedFromElsewhere);
  applyStartupSettings();
  listenExternalUpdates();
  // 串行执行，顺序不能反：自动更新是全量刷新（含补全缺失项），先跑它，backfill 随后基本无事可做，
  // 避免同一部番剧被连续请求 Bangumi 两次。
  if (await tryAutoUpdate() === 'ok') showToast('番剧信息已自动更新');
  await backfillMissingAirRanges();
  console.log('AnimeCal initialized');
}

document.addEventListener('DOMContentLoaded', init);
