/**
 * 日历渲染模块
 */
import { getUpdateCountsForMonth } from './anime.js';

const MONTH_NAMES = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月'
];

export class Calendar {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.currentDate = new Date();
    this.selectedDate = null;
    this.onDateClick = options.onDateClick || (() => {});
    this.render();
  }

  get currentYear() { return this.currentDate.getFullYear(); }
  get currentMonth() { return this.currentDate.getMonth(); }

  // 切月时固定到当月 1 号，避免 currentDate 的「日」在短月份里进位跳月
  prevMonth() {
    this.currentDate = new Date(this.currentYear, this.currentMonth - 1, 1);
    this.render();
  }

  nextMonth() {
    this.currentDate = new Date(this.currentYear, this.currentMonth + 1, 1);
    this.render();
  }

  goToToday() {
    this.currentDate = new Date();
    this.render();
  }

  render() {
    const year = this.currentYear;
    const month = this.currentMonth;
    
    const titleEl = document.getElementById('month-year');
    if (titleEl) titleEl.textContent = `${year}年 ${MONTH_NAMES[month]}`;

    const updateStats = getUpdateCountsForMonth(year, month);
    const firstDayOfMonth = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startWeekday = firstDayOfMonth.getDay();
    const prevMonthDays = new Date(year, month, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
    const todayDate = today.getDate();

    let html = '';

    for (let i = startWeekday - 1; i >= 0; i--) {
      const day = prevMonthDays - i;
      html += `<div class="day-cell other-month" data-prev data-day="${day}" data-year="${year}" data-month="${month - 1}"><span class="day-number">${day}</span></div>`;
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const isToday = isCurrentMonth && day === todayDate;
      const isSelected = this.selectedDate && 
        this.selectedDate.year === year && 
        this.selectedDate.month === month && 
        this.selectedDate.day === day;
      const s = updateStats[day] || { episodes: 0, unwatched: 0 };
      const hasEpisodes = s.episodes > 0;
      // 当天有集且全部已看 → “x集”文字变灰
      const allWatched = hasEpisodes && s.unwatched === 0;
      // 绿点仅在「该日已到达且仍有未看集」时显示；未到达（晚于今天）的日期虽显示集数但不亮绿点
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const isReached = new Date(year, month, day) <= todayStart;
      const showDot = isReached && s.unwatched > 0;

      let classes = 'day-cell';
      if (isToday) classes += ' today';
      if (isSelected) classes += ' selected';

      html += `<div class="${classes}" data-day="${day}" data-year="${year}" data-month="${month}">
        <span class="day-number">${day}</span>
        ${hasEpisodes ? `<span class="day-update-count${allWatched ? ' all-watched' : ''}">${s.episodes}集</span>` : ''}
        ${showDot ? '<span class="update-indicator"></span>' : ''}
      </div>`;
    }

    const totalCells = startWeekday + daysInMonth;
    const remainingCells = 42 - totalCells;
    for (let day = 1; day <= remainingCells; day++) {
      html += `<div class="day-cell other-month" data-next data-day="${day}" data-year="${year}" data-month="${month + 1}"><span class="day-number">${day}</span></div>`;
    }

    this.container.innerHTML = html;

    this.container.querySelectorAll('.day-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const day = parseInt(cell.dataset.day);
        const cellYear = parseInt(cell.dataset.year);
        const cellMonth = parseInt(cell.dataset.month);
        // 跨月格子：切到该月
        if (cell.hasAttribute('data-prev') || cell.hasAttribute('data-next')) {
          this.currentDate = new Date(cellYear, cellMonth, 1);
        }
        this.selectedDate = { year: cellYear, month: cellMonth, day };
        this.render();
        this.onDateClick(new Date(cellYear, cellMonth, day));
      });
    });
  }
}
