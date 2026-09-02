/**
 * 应用主逻辑（主日历窗口）
 */
import { Calendar } from './calendar.js';
import * as AnimeStore from './anime.js';
import * as BangumiAPI from './bangumi.js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
let calendar = null;
let currentView = 'calendar';
let currentDetailDate = null;

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
  syncPinButton(settings.alwaysOnTop);
}

async function syncCloseToTray(value) {
  try {
    await invoke('set_close_to_tray', { value });
  } catch (err) {
    console.warn('syncCloseToTray failed', err);
  }
}

function syncPinButton(pinned) {
  const btn = document.getElementById('btn-toggle-pin');
  btn.classList.toggle('active', !!pinned);
  btn.classList.toggle('pinned', !!pinned);
  btn.title = pinned ? '已置顶（点击取消）' : '未置顶（点击置顶）';
  btn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  btn.innerHTML = pinned
    ? '<span class="pin-icon">📌</span>'
    : '<span class="pin-icon pin-off">📍</span>';
  document.getElementById('always-on-top').checked = !!pinned;
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

  document.getElementById('auto-update').addEventListener('change', (e) => {
    AnimeStore.updateSettings({ autoUpdate: e.target.checked });
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

/** 手动刷新：强制从 Bangumi 重新拉取所有已追番剧的最新播出/集数信息 */
async function manualRefreshAnimeInfo() {
  const list = AnimeStore.getMyAnime().filter(a => a.bangumiId);
  if (!list.length) {
    showToast('暂无已追番剧可刷新');
    return;
  }
  showToast(`正在刷新 ${list.length} 部番剧信息...`, 3500);
  let ok = 0;
  for (const anime of list) {
    try {
      const detail = await BangumiAPI.getSubjectDetail(anime.bangumiId);
      AnimeStore.backfillAirRange(anime.id, detail);
      ok++;
    } catch (err) {
      console.warn('手动刷新失败', anime.name, err);
    }
  }
  refreshMainUi();
  showToast(ok > 0 ? `已更新 ${ok} 部番剧信息` : '刷新失败，请检查网络连接');
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

function init() {
  initCalendar();
  bindEvents();
  initWindowDragging();
  applyStartupSettings();
  listenExternalUpdates();
  backfillMissingAirRanges();
  console.log('AnimeCal initialized');
}

document.addEventListener('DOMContentLoaded', init);
