/**
 * 「管理番剧」独立窗口：仅显示我已追的番剧
 * - 卡片右端提供「取消追番」
 * - 卡片下方显示集数格子：绿=已看、白=未看、灰=未更新，点击可切换已看
 */
import * as AnimeStore from './anime.js';
import { initBackground } from './background.js';
import { invoke } from '@tauri-apps/api/core';

const CELL_STATE = {
  watched: 'watched',
  unwatched: 'unwatched',
  pending: 'pending',
};

function episodeCellState(item) {
  if (item.watched) return CELL_STATE.watched;   // 先看已看
  return item.aired ? CELL_STATE.unwatched : CELL_STATE.pending; // 已到播出日未看 / 未到
}

async function notifyMainWindow() {
  try {
    await invoke('notify_all_windows');
  } catch (err) {
    console.warn('notify_all_windows failed', err);
  }
  // 保留 storage 事件作为兜底（不同窗口 localStorage 路径一致时也能触发刷新）
  try {
    localStorage.setItem('anime_cal_ping', String(Date.now()));
  } catch {
    /* ignore */
  }
}

/** 「已全部看完」= 该番每一集都已标记已看（未播出的集不可能已看，因此等价于完结且追完） */
function getFinishedAnime() {
  return AnimeStore.getMyAnime().filter(anime => {
    const eps = AnimeStore.getEpisodeStatusList(anime);
    return eps.length > 0 && eps.every(e => e.watched);
  });
}

/** 没有可清除的番剧时把按钮置灰，避免点了没反应 */
function syncClearButton() {
  const btn = document.getElementById('btn-clear-finished');
  const count = getFinishedAnime().length;
  btn.disabled = count === 0;
  btn.title = count ? `清除 ${count} 部已全部看完的番剧` : '没有已全部看完的番剧';
}

/** 待清除列表，确认时才真正删除 */
let pendingClear = [];

function openClearDialog() {
  pendingClear = getFinishedAnime();
  if (pendingClear.length === 0) return;

  document.getElementById('clear-dialog-list').innerHTML = pendingClear.map(anime => {
    const eps = AnimeStore.getEpisodeStatusList(anime);
    const watched = eps.filter(e => e.watched).length;
    return `<div class="dialog-item">
      <img class="dialog-item-cover" src="${anime.cover || ''}" alt="${anime.name}" onerror="this.style.visibility='hidden'"/>
      <div class="dialog-item-info">
        <div class="dialog-item-name">${anime.name}</div>
        <div class="dialog-item-sub">已看 ${watched}/${eps.length} 集</div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('clear-dialog').hidden = false;
}

function closeClearDialog() {
  document.getElementById('clear-dialog').hidden = true;
  pendingClear = [];
}

async function confirmClear() {
  const removed = pendingClear.filter(anime => {
    const result = AnimeStore.removeMyAnime(anime.id);
    return result && result.success;
  }).length;
  closeClearDialog();
  if (removed > 0) await notifyMainWindow();
  render();
}

function render() {
  const container = document.getElementById('following-list');
  const list = AnimeStore.getMyAnime();
  syncClearButton();

  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">TV</div>还没有追番，点击主窗口设置里的「添加番剧」开始关注</div>';
    return;
  }

  container.innerHTML = list.map(anime => {
    const statusList = AnimeStore.getEpisodeStatusList(anime);
    const watchedCount = statusList.filter(s => s.watched).length;
    const airedCount = statusList.filter(s => s.aired).length;
    const cells = statusList.map(s =>
      `<span class="ep-cell ${episodeCellState(s)}" data-id="${anime.id}" data-ep="${s.episode}" title="第 ${s.episode} 集（点击切换已看）">${s.episode}</span>`
    ).join('');
    const sub = anime.totalEpisodes
      ? `已看 ${watchedCount}/${airedCount} · 共 ${anime.totalEpisodes} 集`
      : `已看 ${watchedCount}/${airedCount} 集`;
    return `
      <div class="follow-item">
        <img class="follow-cover" src="${anime.cover || ''}" alt="${anime.name}" onerror="this.style.visibility='hidden'"/>
        <div class="follow-info">
          <div class="follow-title">${anime.name}</div>
          <div class="follow-sub">${sub}${anime.airTime ? ' · ' + anime.airTime : ''}</div>
          <div class="ep-grid">${cells}</div>
        </div>
        <button class="unfollow-btn" data-id="${anime.id}" title="取消追番">&times;</button>
      </div>`;
  }).join('');

  container.querySelectorAll('.unfollow-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const result = AnimeStore.removeMyAnime(btn.dataset.id);
      if (result.success) {
        await notifyMainWindow();
        render();
      }
    });
  });

  // 集数格子：点击即切换该集「已看」；再点取消（含未更新集）
  container.querySelectorAll('.ep-cell').forEach(cell => {
    cell.addEventListener('click', async () => {
      AnimeStore.toggleEpisodeWatched(cell.dataset.id, cell.dataset.ep);
      await notifyMainWindow();
      render();
    });
  });
}

async function listenExternalUpdates() {
  try {
    await window.__TAURI__?.event?.listen?.('anime-data-changed', () => {
      render();
    });
  } catch (err) {
    console.warn('following listen anime-data-changed failed', err);
  }
  window.addEventListener('storage', (e) => {
    if (e.key === 'anime_cal_ping' || e.key === 'anime_cal_data') {
      render();
    }
  });
}

function init() {
  initBackground('following');
  document.getElementById('btn-clear-finished').addEventListener('click', openClearDialog);
  document.getElementById('btn-clear-cancel').addEventListener('click', closeClearDialog);
  document.getElementById('btn-clear-confirm').addEventListener('click', confirmClear);

  // 点遮罩空白处或按 Esc 也能取消
  const overlay = document.getElementById('clear-dialog');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeClearDialog();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeClearDialog();
  });

  render();
  listenExternalUpdates();
}

document.addEventListener('DOMContentLoaded', init);