/**
 * 「管理番剧」独立窗口：仅显示我已追的番剧
 * - 卡片右端提供「取消追番」
 * - 卡片下方显示集数格子：绿=已看、白=未看、灰=未更新，点击可切换已看
 */
import * as AnimeStore from './anime.js';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
    await window.__TAURI__?.event?.emit?.('anime-data-changed');
  } catch (err) {
    console.warn('emit anime-data-changed failed', err);
  }
  try {
    localStorage.setItem('anime_cal_ping', String(Date.now()));
  } catch {
    /* ignore */
  }
}

function render() {
  const container = document.getElementById('following-list');
  const list = AnimeStore.getMyAnime();

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

async function closeWindow() {
  try {
    await getCurrentWindow().close();
    return;
  } catch (err) {
    console.warn('close following via tauri failed', err);
  }
  // 兜底：避免 window.close() 仅白屏，改用 hide
  try {
    await getCurrentWindow().hide();
  } catch (err2) {
    console.warn('hide following via tauri failed', err2);
  }
}

function init() {
  document.getElementById('btn-close-following').addEventListener('click', closeWindow);
  render();
}

document.addEventListener('DOMContentLoaded', init);