"use strict";
// Последовательная очередь «тяжёлых» операций со стикерами (сборка, добавление,
// конвертация). Telegram не любит параллельные штормы от одного бота — ловим
// 429/flood. Один активный джоб, остальные ждут и получают свою позицию.
class JobQueue {
  constructor() {
    this.active = null;
    this.waiting = [];
  }

  isBusy() {
    return !!this.active || this.waiting.length > 0;
  }

  // Позиция, которую занял бы новый джоб прямо сейчас (0 = сразу в работу).
  ahead() {
    return this.waiting.length + (this.active ? 1 : 0);
  }

  enqueue(meta, fn) {
    return new Promise((resolve, reject) => {
      const job = { meta: meta || {}, fn, resolve, reject };
      this.waiting.push(job);
      this.notifyPositions();
      this.pump();
    });
  }

  notifyPositions() {
    this.waiting.forEach((job, i) => {
      try {
        if (job.meta.onPosition) {
          const r = job.meta.onPosition(i + 1);
          if (r && r.catch) r.catch(() => {});
        }
      } catch (_) {}
    });
  }

  async pump() {
    if (this.active || !this.waiting.length) return;
    const job = this.waiting.shift();
    this.active = job;
    this.notifyPositions();
    try {
      if (job.meta.onStart) {
        const r = job.meta.onStart();
        if (r && r.catch) r.catch(() => {});
      }
    } catch (_) {}
    try {
      job.resolve(await job.fn());
    } catch (e) {
      job.reject(e);
    } finally {
      this.active = null;
      this.pump();
    }
  }

  stats() {
    const slim = (m) =>
      m ? { user_id: m.userId || null, kind: m.kind || "", label: m.label || "" } : null;
    return {
      active: this.active ? slim(this.active.meta) : null,
      waiting: this.waiting.map((j) => slim(j.meta)),
    };
  }
}

// Одна общая очередь на все операции с паками.
const stickerQueue = new JobQueue();

module.exports = { JobQueue, stickerQueue };
