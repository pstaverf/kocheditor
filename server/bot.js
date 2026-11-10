"use strict";
// Главный бот (вебхук /telegram/webhook): открывает WebApp, принимает загрузки,
// СОБИРАЕТ паки из мини-аппы с живым прогрессом и даёт управлять паками
// (переименовать / добавить / убрать / конвертировать / удалить).
// Персональные pack-боты юзеров: вебхук /telegram/webhook/pack/:userId.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const config = require("./config");
const db = require("./db");
const catalog = require("./catalog");
const tg = require("./telegram");
const build = require("./build");
const { stickerQueue } = require("./queue");

// Кастомные эмодзи для текстов бота (HTML-разметка tg-emoji; если Telegram не
// отдаст кастомный — покажется обычный символ внутри тега).
const EMOJI_IDS = {
  cry: "5213090867044162716",
  sad: "5228947933545635555",
  clap: "5424939755257208778",
  wave2: "5472427507842032538",
  cool: "5474667187258006816",
  knife: "5447587852248458947",
  check: "5472180551517477902",
  wave: "5339517760592421605",
  cry2: "5472125180799098428",
  down: "5879883461711367869",
  repeat: "6005843436479975944",
  left: "5877536313623711363",
  right: "5875506366050734240",
  check2: "5825794181183836432",
  doc: "5839323457015256759",
  outbox: "5877540355187937244",
  inbox: "5877307202888273539",
  trash: "5841541824803509441",
  pencil: "5879841310902324730",
  refresh: "5877410604225924969",
  control: "5936170807716745162",
  timer: "5877613700344450910",
  warn: "5881702736843511327",
  excl: "5775887550262546277",
  shield: "5931409969613116639",
};
const FALLBACKS = {
  cry: "😭", sad: "😫", clap: "👏", wave2: "👋", cool: "😎", knife: "🔪",
  check: "✅", wave: "👋", cry2: "😭", down: "⬇️", repeat: "🔁", left: "⬅️",
  right: "➡️", check2: "✔️", doc: "📄", outbox: "📤", inbox: "📥", trash: "🗑",
  pencil: "✏️", refresh: "🔄", control: "🎛", timer: "⏲", warn: "⚠️",
  excl: "❗", shield: "🛡",
};
const e = (name) =>
  `<tg-emoji emoji-id="${EMOJI_IDS[name] || ""}">${FALLBACKS[name] || ""}</tg-emoji>`;

// ── Анти-спам (rate limit на действия пользователя) ──────────────────────────
// Больше 2 действий в секунду — спам: шлём стикер + предупреждение
// и на COOLDOWN молча игнорируем все апдейты юзера (кроме платежей: их
// нельзя терять, иначе не зачислится оплата).
const ANTISPAM = {
  WINDOW_MS: 1_000,
  MAX_ACTIONS: 2,
  COOLDOWN_MS: 30_000,
  STICKER_FILE_ID:
    "CAACAgIAAxkBAAESL-tq8zKdiryx56eO3azW4ykBEQNA_gACj6QAAs53mUtvux3KYyTjrz0E",
};
const spamHits = new Map();
const spamCooldownUntil = new Map();

// -> "ok" | "warn" (только что превысил, надо наказать) | "blocked" (кулдаун)
function spamGate(userId) {
  if (userId == null) return "ok";
  const now = Date.now();
  const until = spamCooldownUntil.get(userId) || 0;
  if (until > now) return "blocked";
  if (until) spamCooldownUntil.delete(userId);
  if (spamHits.size > 10_000) {
    // Не даём картам расти бесконечно.
    for (const [k, arr] of spamHits) {
      if (!arr.length || now - arr[arr.length - 1] > ANTISPAM.WINDOW_MS) spamHits.delete(k);
    }
  }
  const hits = (spamHits.get(userId) || []).filter((t) => now - t < ANTISPAM.WINDOW_MS);
  hits.push(now);
  if (hits.length > ANTISPAM.MAX_ACTIONS) {
    spamHits.set(userId, []);
    spamCooldownUntil.set(userId, now + ANTISPAM.COOLDOWN_MS);
    return "warn";
  }
  spamHits.set(userId, hits);
  return "ok";
}

async function punishSpam(userId) {
  await tg
    .tgApi(config.botToken, "sendSticker", {
      chat_id: userId,
      sticker: ANTISPAM.STICKER_FILE_ID,
    })
    .catch(() => {});
  await tg
    .sendMessage(
      config.botToken,
      userId,
      `${e("warn")} <b>Эй, не спамь!</b> ${e("cry2")}\n` +
        `Слишком много запросов подряд — я на ${Math.round(ANTISPAM.COOLDOWN_MS / 1000)} секунд перестану тебе отвечать. ` +
        `Подожди немного и попробуй снова.`
    )
    .catch(() => {});
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function webAppKeyboard() {
  if (!config.publicUrl) return undefined;
  return { inline_keyboard: [[{ text: "🎨 Открыть редактор", web_app: { url: config.publicUrl } }]] };
}

// Человекочитаемая длительность: 45 сек / 1 мин 20 сек / 12 мин.
function formatRemaining(ms) {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec} сек`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} мин ${s} сек` : `${m} мин`;
}
// Веса стадий сборки для оценки общего прогресса и оставшегося времени.
const STAGE_SPAN = {
  render: [0, 0.45],
  upload: [0.45, 0.45],
  create: [0.9, 0.1],
};

function progressBar(done, total) {
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  const filled = Math.round(pct / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled) + ` ${pct}%`;
}

// ── Прогресс-сообщение в боте ────────────────────────────────────────────────
// Возвращает объект с update/done/fail или null, если писать некому.
async function startProgress(userId, title, queuePosition = 0) {
  const token = config.botToken;
  if (!token) return null;
  let msg;
  try {
    msg = await tg.sendMessage(
      token,
      userId,
      queuePosition > 0
        ? `${e("down")} <b>Вы в очереди</b> №${queuePosition}\n${escapeHtml(title)}\nДойдёт очередь — сразу начну собирать.`
        : `${e("timer")} <b>Загружаю…</b>\n${escapeHtml(title)}\n${progressBar(0, 1)}`
    );
  } catch (err) {
    console.warn("[bot] progress send failed:", err.message);
    return null;
  }
  const messageId = msg.message_id;
  let startedAt = 0;
  let lastText = "";
  let lastStage = "";
  let lastPct = -100;
  let lastEditAt = 0;
  const edit = async (text, extra) => {
    if (text === lastText && !extra) return;
    lastText = text;
    try {
      await tg.editMessageText(token, userId, messageId, text, extra || {});
    } catch (err) {
      if (!/message is not modified/i.test(err.message)) {
        console.warn("[bot] progress edit failed:", err.message);
      }
    }
  };
  return {
    async queued(pos) {
      await edit(
        `${e("down")} <b>Вы в очереди</b> №${pos}\n${escapeHtml(title)}\nДойдёт очередь — сразу начну собирать.`
      );
    },
    async begin() {
      startedAt = Date.now();
      await edit(`${e("timer")} <b>Загружаю…</b>\n${escapeHtml(title)}\n${progressBar(0, 1)}`);
    },
    async update(stage, done, total) {
      const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
      const now = Date.now();
      const stageChanged = stage !== lastStage;
      // Не чаще раза в 1.2 c и не на каждый процент — иначе флуд-контроль Telegram.
      if (!stageChanged && done < total && pct - lastPct < 4 && now - lastEditAt < 1200) return;
      lastStage = stage;
      lastPct = pct;
      lastEditAt = now;
      const label =
        stage === "render"
          ? "Рисую эмодзи"
          : stage === "upload"
            ? "Отправляю в Telegram"
            : "Создаю пак";
      // Оценка оставшегося времени по уже затраченному и доле готовности.
      if (!startedAt) startedAt = now;
      const span = STAGE_SPAN[stage] || [0, 1];
      const frac = span[0] + span[1] * (total > 0 ? done / total : 1);
      let etaLine = "";
      if (frac > 0.03 && frac < 1) {
        const etaMs = ((now - startedAt) * (1 - frac)) / frac;
        if (etaMs >= 3000) etaLine = `\nОсталось ждать ~${formatRemaining(etaMs)}`;
      }
      await edit(
        `${e("timer")} <b>Загружаю…</b>\n${escapeHtml(title)}\n${label}: ${done}/${total}\n${progressBar(done, total)}${etaLine}`
      );
    },
    async done(text, replyMarkup) {
      await edit(text, replyMarkup ? { reply_markup: replyMarkup } : {});
    },
    async fail(err) {
      await edit(`${e("warn")} <b>Не получилось</b>\n${escapeHtml(err.message || String(err))}`);
    },
  };
}

function starsNeeded(count) {
  return count * (config.starPerSticker || 1);
}

function needStarsError(needed, balance) {
  const err = new Error(
    `Не хватает ⭐: нужно ${needed}, на балансе ${balance}. Пополни командой /topup или в профиле приложения.`
  );
  err.needStars = true;
  err.needed = needed;
  err.balance = balance;
  return err;
}

// Сборка пака из мини-аппы: очередь, бот показывает прогресс и карточку пака.
async function runBuildWithProgress(userId, job) {
  const title = `Собираю пак «${job.title}»`;
  const cap = job.format === "sticker" ? build.STICKER_LIMIT : build.EMOJI_LIMIT;
  const uniqueCount = new Set((job.ids || []).map(String)).size;
  const needed = starsNeeded(Math.min(uniqueCount, cap));
  const balance = db.getBalance(userId);
  if (balance < needed) throw needStarsError(needed, balance);

  let progress = null;
  const ahead = stickerQueue.ahead();
  if (ahead > 0) progress = await startProgress(userId, title, ahead);

  return stickerQueue.enqueue(
    {
      userId,
      kind: "build",
      label: job.title || "пак",
      onPosition: (pos) => (progress ? progress.queued(pos) : undefined),
    },
    async () => {
      if (!progress) progress = await startProgress(userId, title);
      else await progress.begin();
      try {
        const { pack, errors } = await build.createPack({
          ...job,
          userId,
          onProgress: progress ? (s, d, t) => progress.update(s, d, t) : undefined,
        });
        // Списываем только за реально созданные эмодзи.
        if (pack.count > 0) db.debitStars(userId, starsNeeded(pack.count));
        const packObj = db.getPack(pack.id);
        const warn = errors && errors.length ? `\n${e("warn")} Не влезло эмодзи: ${errors.length}` : "";
        const paid = pack.count > 0 ? `\nСписано: ${starsNeeded(pack.count)} ⭐ · баланс: ${db.getBalance(userId)} ⭐` : "";
        const text =
          `${e("check")} <b>Пак готов!</b>\n` +
          `${e("doc")} <b>${escapeHtml(pack.title)}</b> · ${pack.count} шт.\n${pack.link}${warn}${paid}`;
        if (progress) {
          await progress.done(text, packObj ? packKeyboard(packObj) : undefined);
        } else if (config.botToken) {
          await tg
            .sendMessage(config.botToken, userId, text, packObj ? { reply_markup: packKeyboard(packObj) } : {})
            .catch(() => {});
        }
        if (packObj) await sendFirstSticker(userId, packObj);
        return pack;
      } catch (err) {
        if (progress) await progress.fail(err);
        throw err;
      }
    }
  );
}

// Прислать первый стикер готового пака отдельным сообщением — чтобы пак был
// виден прямо в чате, а не только по ссылке.
async function sendFirstSticker(userId, pack) {
  if (!config.botToken) return;
  try {
    const bot = await build.botForPack(pack);
    const set = await tg.tgApi(bot.token, "getStickerSet", { name: pack.short_name });
    const first = set && set.stickers && set.stickers[0];
    if (!first) return;
    await tg.tgApi(config.botToken, "sendSticker", {
      chat_id: userId,
      sticker: first.file_id,
    });
  } catch (err) {
    console.warn("[bot] sendFirstSticker failed:", err.message);
  }
}

// ── Карточка и управление паком ──────────────────────────────────────────────
function packKeyboard(pack) {
  return {
    inline_keyboard: [
      [{ text: "📤 Открыть пак", url: pack.link }],
      [
        { text: "✏️ Переименовать", callback_data: `pk:${pack.id}:rename` },
        { text: "➕ Добавить эмодзи", callback_data: `pk:${pack.id}:add` },
      ],
      [
        { text: "➖ Убрать эмодзи", callback_data: `pk:${pack.id}:remove` },
        { text: "🔁 Конвертировать", callback_data: `pk:${pack.id}:conv` },
      ],
      [{ text: "🗑 Удалить пак", callback_data: `pk:${pack.id}:del` }],
    ],
  };
}

function packText(pack) {
  const fmt = pack.format === "sticker" ? "стикеры" : "эмодзи";
  return (
    `${e("doc")} <b>${escapeHtml(pack.title)}</b>\n` +
    `Формат: ${fmt} · ${pack.included.length} шт.\n${pack.link}\n\n` +
    `${e("control")} Что делаем с паком?`
  );
}

async function sendPackCard(userId, pack) {
  await tg.sendMessage(config.botToken, userId, packText(pack), {
    reply_markup: packKeyboard(pack),
  });
}

async function sendPacksList(userId) {
  const mine = db.listPacks(userId);
  if (!mine.length) {
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("sad")} Паков пока нет.\nОткрой редактор, собери эмодзи и нажми «Создать пак» — ` +
        `сборка придёт сюда, с прогрессом ${e("down")}`,
      { reply_markup: webAppKeyboard() }
    );
    return;
  }
  const rows = mine.slice(0, 20).map((p) => [
    {
      text: `📄 ${p.title} · ${p.included.length}`,
      callback_data: `pk:${p.id}:menu`,
    },
  ]);
  await tg.sendMessage(
    config.botToken,
    userId,
    `${e("doc")} <b>Твои паки</b> (${mine.length})\nВыбери пак, чтобы изменить, дополнить или удалить:`,
    { reply_markup: { inline_keyboard: rows } }
  );
}

// ── Загрузки своих эмодзи ────────────────────────────────────────────────────
function assertLottie(buf) {
  const json = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
  if (!json || !Array.isArray(json.layers)) throw new Error("not a Lottie animation");
}

function storeUploadedTgs(userId, buf) {
  assertLottie(buf);
  fs.mkdirSync(catalog.UPLOAD_DIR, { recursive: true });
  // Имя файла узнаем только после вставки (upload:N), поэтому двухшагово:
  const item = db.addUploadItem({ file: "pending", user_id: userId });
  const fileName = `${item.id.replace("upload:", "")}.tgs`;
  try {
    fs.writeFileSync(path.join(catalog.UPLOAD_DIR, fileName), buf);
    db.open()
      .prepare("UPDATE upload_items SET file = ? WHERE id = ?")
      .run(fileName, item.id);
  } catch (err) {
    db.deleteUploadItem(item.id);
    throw err;
  }
  item.file = fileName;
  return item;
}

async function downloadTelegramFile(fileId) {
  const file = await tg.tgApi(config.botToken, "getFile", { file_id: fileId });
  return tg.tgDownload(config.botToken, file.file_path);
}

async function extractAnimatedFileId(msg) {
  if (msg.sticker && msg.sticker.is_animated) return msg.sticker.file_id;
  if (msg.document && (msg.document.file_name || "").toLowerCase().endsWith(".tgs")) {
    return msg.document.file_id;
  }
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const ce = entities.find((x) => x.type === "custom_emoji");
  if (ce && ce.custom_emoji_id && config.botToken) {
    try {
      const stickers = await tg.tgApi(config.botToken, "getCustomEmojiStickers", {
        custom_emoji_ids: [ce.custom_emoji_id],
      });
      const st = Array.isArray(stickers) && stickers[0];
      if (st && st.is_animated) return st.file_id;
    } catch (err) {
      console.warn("[bot] getCustomEmojiStickers failed:", err.message);
    }
  }
  return null;
}

function parseTileIds(text) {
  const out = [];
  for (const tok of String(text || "").split(/[\s,;]+/).filter(Boolean)) {
    if (/^\d+$/.test(tok)) out.push(tok);
    else if (/^(new|upload):\d+$/i.test(tok)) out.push(tok.toLowerCase());
  }
  return out;
}

// ── Действия с паком из чата ─────────────────────────────────────────────────
async function doAddTiles(userId, pack, tileIds, progressTitle) {
  const title = progressTitle || `Добавляю в «${pack.title}»`;
  const includedSet = new Set((pack.included || []).map(String));
  const want = [...new Set((tileIds || []).map(String))].filter((id) => !includedSet.has(id)).length;
  const balance = db.getBalance(userId);
  if (balance < starsNeeded(want)) {
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("warn")} Не хватает ⭐: нужно ${starsNeeded(want)}, на балансе ${balance}.`,
      { reply_markup: topupKeyboard() }
    );
    return;
  }
  let progress = null;
  const ahead = stickerQueue.ahead();
  if (ahead > 0) progress = await startProgress(userId, title, ahead);
  await stickerQueue.enqueue(
    {
      userId,
      kind: "add",
      label: pack.title || "пак",
      onPosition: (pos) => (progress ? progress.queued(pos) : undefined),
    },
    async () => {
      if (!progress) progress = await startProgress(userId, title);
      else await progress.begin();
      try {
        const { added, errors } = await build.addTiles(pack, tileIds, {}, (s, d, t) =>
          progress.update(s, d, t)
        );
        if (added.length) db.debitStars(userId, starsNeeded(added.length));
        const fresh = db.getPack(pack.id) || pack;
        const text =
          `${e("check")} <b>Готово!</b> Добавил: ${added.length}` +
          (errors.length ? `\n${e("warn")} Не получилось: ${errors.length}` : "") +
          (added.length ? `\nСписано: ${starsNeeded(added.length)} ⭐ · баланс: ${db.getBalance(userId)} ⭐` : "") +
          `\n${e("doc")} <b>${escapeHtml(fresh.title)}</b> · теперь ${fresh.included.length} шт.\n${fresh.link}`;
        await progress.done(text, packKeyboard(fresh));
      } catch (err) {
        if (progress) await progress.fail(err);
        else throw err;
      }
    }
  );
}

async function handlePendingText(userId, pending, text) {
  if (pending.action === "topup_amount") {
    const amount = parseInt(text.replace(/\D+/g, ""), 10);
    if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
      await tg.sendMessage(
        config.botToken,
        userId,
        `${e("excl")} Нужно число от 1 до 500. Сколько звёзд пополняем? (или /cancel)`
      );
      return true;
    }
    db.clearPending(userId);
    await sendTopupInvoice(userId, amount);
    return true;
  }
  if (pending.action === "mailing_text") {
    const body = String(text || "").trim();
    if (!body) return false;
    db.setPending(userId, "mailing_confirm", null, 10 * 60 * 1000, body);
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("doc")} <b>Предпросмотр рассылки</b> (${db.usersCount()} получателей):\n\n${escapeHtml(body)}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📤 Отправить всем", callback_data: "adm:mail:send" },
              { text: "Отмена", callback_data: "adm:mail:cancel" },
            ],
          ],
        },
      }
    );
    return true;
  }
  const pack = db.getPackForUser(pending.pack_id, userId);
  if (!pack) {
    db.clearPending(userId);
    await tg.sendMessage(config.botToken, userId, `${e("warn")} Пак не найден. Открой /packs`);
    return true;
  }
  if (pending.action === "rename") {
    const title = text.trim().slice(0, 40);
    if (!title) return false;
    db.clearPending(userId);
    await build.renamePack(pack, title);
    const fresh = db.getPack(pack.id) || pack;
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("check2")} Переименовал в <b>${escapeHtml(fresh.title)}</b>`,
      { reply_markup: packKeyboard(fresh) }
    );
    return true;
  }
  if (pending.action === "add") {
    const ids = parseTileIds(text);
    if (!ids.length) {
      await tg.sendMessage(
        config.botToken,
        userId,
        `${e("excl")} Не понял номера. Пришли, например: <code>12, 45, new:3</code> — или отправь сам эмодзи файлом/стикером.`
      );
      return true;
    }
    db.clearPending(userId);
    await doAddTiles(userId, pack, ids);
    return true;
  }
  if (pending.action === "remove") {
    const positions = parseTileIds(text)
      .filter((x) => /^\d+$/.test(x))
      .map(Number);
    if (!positions.length) {
      await tg.sendMessage(
        config.botToken,
        userId,
        `${e("excl")} Пришли номера позиций из списка выше, например: <code>2, 5</code>`
      );
      return true;
    }
    db.clearPending(userId);
    const removed = await build.removeTiles(pack, positions);
    const fresh = db.getPack(pack.id) || pack;
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("trash")} Убрал эмодзи: ${removed.length}. Осталось ${fresh.included.length}.`,
      { reply_markup: packKeyboard(fresh) }
    );
    return true;
  }
  return false;
}

async function handlePendingFile(userId, pending, fileId) {
  const pack = db.getPackForUser(pending.pack_id, userId);
  if (!pack) {
    db.clearPending(userId);
    return;
  }
  const buf = await downloadTelegramFile(fileId);
  const item = storeUploadedTgs(userId, buf);
  db.clearPending(userId);
  await doAddTiles(userId, pack, [item.id], `Добавляю твой эмодзи в «${pack.title}»`);
}

async function acceptUpload(userId, fileId) {
  const session = db.getUploadSession(userId);
  if (!session || session.expires_at < Date.now()) {
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("excl")} Сначала нажми «+» в редакторе, а уже потом отправляй эмодзи сюда. ` +
        `Либо открой /packs и жми «Добавить эмодзи» у нужного пака.`,
      { reply_markup: webAppKeyboard() }
    );
    return;
  }
  try {
    const buf = await downloadTelegramFile(fileId);
    const item = storeUploadedTgs(userId, buf);
    db.setUploadSession(userId, {
      status: "ready",
      expires_at: session.expires_at,
      upload_id: item.id,
      error: "",
    });
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("check")} Принял! Возвращайся в редактор — эмодзи уже в каталоге.`
    );
  } catch (err) {
    db.setUploadSession(userId, {
      status: "error",
      expires_at: session.expires_at,
      upload_id: null,
      error: "Не удалось принять файл: " + err.message,
    });
    await tg
      .sendMessage(config.botToken, userId, `${e("cry")} Не смог принять этот файл. Попробуй другой эмодзи.`)
      .catch(() => {});
  }
}

// ── Баланс, оплата Stars, статистика, рассылка ───────────────────────────────
function isAdmin(userId) {
  return (config.adminIds || []).includes(Number(userId));
}

function topupKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⭐ 10", callback_data: "pay:10" },
        { text: "⭐ 25", callback_data: "pay:25" },
        { text: "⭐ 50", callback_data: "pay:50" },
      ],
      [
        { text: "⭐ 100", callback_data: "pay:100" },
        { text: "⭐ 250", callback_data: "pay:250" },
        { text: "⭐ 500", callback_data: "pay:500" },
      ],
      [{ text: "✏️ Своя сумма (1–500)", callback_data: "pay:custom" }],
    ],
  };
}

async function sendBalance(userId) {
  const u = db.getUser(userId);
  await tg.sendMessage(
    config.botToken,
    userId,
    `${e("control")} <b>Твой баланс:</b> ${db.getBalance(userId)} ⭐\n` +
      `1 стикер/эмодзи = ${config.starPerSticker || 1} ⭐\n` +
      `Сделано паков: ${(u && u.packs_made) || 0} · стикеров: ${(u && u.stickers_made) || 0}\n\nПополнить?`,
    { reply_markup: topupKeyboard() }
  );
}

async function sendTopupInvoice(userId, amount) {
  const sum = Math.floor(Number(amount));
  if (!Number.isFinite(sum) || sum < 1 || sum > 500) {
    await tg.sendMessage(config.botToken, userId, `${e("excl")} Сумма — от 1 до 500 ⭐.`);
    return;
  }
  const payload = `topup:${userId}:${sum}:${Date.now().toString(36)}`;
  await tg.tgApi(config.botToken, "sendInvoice", {
    chat_id: userId,
    title: "Пополнение баланса",
    description: `${sum} Telegram Stars = ${sum} стикеров/эмодзи в редакторе`,
    payload,
    currency: "XTR",
    prices: [{ label: `${sum} Telegram Stars`, amount: sum }],
  });
}

async function handlePreCheckout(pq) {
  const payload = String((pq && pq.invoice_payload) || "");
  const parts = payload.split(":");
  const ok =
    parts[0] === "topup" &&
    Number(parts[1]) === (pq.from && pq.from.id) &&
    pq.currency === "XTR" &&
    Number.isFinite(Number(pq.total_amount)) &&
    Number(pq.total_amount) >= 1 &&
    Number(pq.total_amount) <= 500 &&
    Number(parts[2]) === Number(pq.total_amount);
  try {
    await tg.tgApi(config.botToken, "answerPreCheckoutQuery", {
      pre_checkout_query_id: pq.id,
      ok,
      ...(ok ? {} : { error_message: "Что-то не так с суммой. Попробуй ещё раз через /topup" }),
    });
  } catch (err) {
    console.warn("[bot] preCheckout failed:", err.message);
  }
}

async function handleSuccessfulPayment(msg) {
  const userId = msg.from.id;
  const sp = msg.successful_payment || {};
  if (sp.currency !== "XTR") return;
  const credited = db.creditStars(
    userId,
    Number(sp.total_amount) || 0,
    sp.telegram_payment_charge_id || "",
    sp.invoice_payload || ""
  );
  await tg.sendMessage(
    config.botToken,
    userId,
    credited
      ? `${e("check")} <b>Баланс пополнен на ${sp.total_amount} ⭐!</b>\nТеперь у тебя ${db.getBalance(userId)} ⭐. Открывай редактор и собирай пак.`
      : `${e("check2")} Оплата уже была зачислена раньше. Баланс: ${db.getBalance(userId)} ⭐`,
    { reply_markup: webAppKeyboard() }
  );
}

async function sendStats(userId) {
  if (!isAdmin(userId)) {
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("shield")} Команда для админа.\nТвой ID: <code>${userId}</code> — добавь его в ADMIN_IDS (.env) и перезапусти сервер.`
    );
    return;
  }
  const q = stickerQueue.stats();
  const nowLine = q.active
    ? `Сейчас собирает: ${escapeHtml(q.active.label || "пак")} (юзер ${q.active.user_id})` +
      (q.waiting.length ? `\nВ очереди: ${q.waiting.length}` : "")
    : q.waiting.length
      ? `В очереди: ${q.waiting.length}`
      : "Сейчас никто не собирает";
  await tg.sendMessage(
    config.botToken,
    userId,
    `${e("control")} <b>Статистика бота</b>\n\n` +
      `${e("timer")} ${nowLine}\n` +
      `${e("doc")} Сделано паков: ${db.statsGet("packs_created")}\n` +
      `${e("check")} Сделано стикеров/эмодзи: ${db.statsGet("stickers_created")}\n` +
      `Пользователей: ${db.usersCount()}\n` +
      `Пополнено всего: ${db.totalTopupStars()} ⭐`
  );
}

async function startMailing(userId) {
  if (!isAdmin(userId)) {
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("shield")} Команда для админа.\nТвой ID: <code>${userId}</code> — добавь его в ADMIN_IDS (.env) и перезапусти сервер.`
    );
    return;
  }
  db.setPending(userId, "mailing_text", null);
  await tg.sendMessage(
    config.botToken,
    userId,
    `${e("outbox")} Пришли текст рассылки следующим сообщением. Покажу предпросмотр перед отправкой (или /cancel).`
  );
}

async function runMailing(adminId, text) {
  const ids = db.listUserIds();
  let sent = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await tg.tgApi(config.botToken, "sendMessage", {
        chat_id: id,
        text,
        disable_web_page_preview: true,
      });
      sent++;
    } catch (_) {
      failed++;
    }
    // Не упираемся в лимиты Telegram на массовую отправку.
    await new Promise((r) => setTimeout(r, 60));
  }
  await tg
    .sendMessage(
      config.botToken,
      adminId,
      `${e("outbox")} <b>Рассылка завершена</b>\nОтправлено: ${sent} · не дошло: ${failed} (заблокировали бота и т.п.)`
    )
    .catch(() => {});
}

// ── Колбэки управления паками ────────────────────────────────────────────────
async function handleCallback(cq) {
  const userId = cq.from.id;
  db.touchUser(cq.from || {});
  const data = String(cq.data || "");
  if (data.startsWith("pay:")) {
    await tg.answerCallbackQuery(config.botToken, cq.id).catch(() => {});
    const val = data.slice(4);
    if (val === "custom") {
      db.setPending(userId, "topup_amount", null);
      await tg.sendMessage(
        config.botToken,
        userId,
        `${e("pencil")} Сколько звёзд пополняем? Пришли число от 1 до 500 (или /cancel).`
      );
    } else {
      await sendTopupInvoice(userId, parseInt(val, 10));
    }
    return;
  }
  if (data === "adm:mail:send" || data === "adm:mail:cancel") {
    await tg.answerCallbackQuery(config.botToken, cq.id).catch(() => {});
    const pending = db.getPending(userId);
    const body = pending && pending.action === "mailing_confirm" ? pending.payload || "" : "";
    db.clearPending(userId);
    if (data === "adm:mail:cancel" || !body) {
      await tg.sendMessage(config.botToken, userId, `${e("check2")} Рассылка отменена.`);
      return;
    }
    if (!isAdmin(userId)) return;
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("timer")} Рассылка запущена для ${db.usersCount()} пользователей…`
    );
    setImmediate(() => runMailing(userId, body));
    return;
  }
  const m = data.match(/^pk:(\d+):(\w+)$/);
  if (!m) return;
  const pack = db.getPackForUser(Number(m[1]), userId);
  if (!pack) {
    await tg.answerCallbackQuery(config.botToken, cq.id, "Пак не найден");
    return;
  }
  const action = m[2];
  await tg.answerCallbackQuery(config.botToken, cq.id).catch(() => {});

  if (action === "menu") {
    await sendPackCard(userId, pack);
  } else if (action === "rename") {
    db.setPending(userId, "rename", pack.id);
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("pencil")} Как назвать пак <b>${escapeHtml(pack.title)}</b>?\nПришли новое название следующим сообщением (или /cancel).`
    );
  } else if (action === "add") {
    db.setPending(userId, "add", pack.id);
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("inbox")} Добавляем в <b>${escapeHtml(pack.title)}</b>.\n` +
        `Пришли номера эмодзи из каталога через запятую (например <code>12, 45, new:3</code>) ` +
        `— или просто отправь сюда анимированный стикер/custom emoji, добавлю его.\n` +
        `Быстрее с настройками — в редакторе: кнопка ниже.`,
      { reply_markup: webAppKeyboard() }
    );
  } else if (action === "remove") {
    db.setPending(userId, "remove", pack.id);
    const list = pack.included
      .map((id, i) => `${i + 1}. <code>${escapeHtml(String(id))}</code>`)
      .join("\n");
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("outbox")} В паке <b>${escapeHtml(pack.title)}</b> сейчас:\n${list}\n\n` +
        `Пришли номера позиций, которые убрать (например <code>2, 5</code>), или /cancel.`
    );
  } else if (action === "conv") {
    const progress = await startProgress(userId, `Конвертирую «${pack.title}»`);
    try {
      const need = starsNeeded((pack.included || []).length);
      if (db.getBalance(userId) < need) {
        if (progress) {
          await progress.done(
            `${e("warn")} Не хватает ⭐ на конвертацию: нужно ${need}, на балансе ${db.getBalance(userId)}.`,
            topupKeyboard()
          );
        }
        return;
      }
      const r = await build.convertPack(pack, userId);
      db.debitStars(userId, need);
      const text = `${e("repeat")} <b>Конвертация готова!</b>\nНовый формат: ${r.format === "sticker" ? "стикеры" : "эмодзи"}${r.parts > 1 ? `, паков: ${r.parts}` : ""}. Списано ${need} ⭐. Ссылки — в списке /packs`;
      if (progress) await progress.done(text);
      else await tg.sendMessage(config.botToken, userId, text);
    } catch (err) {
      if (progress) await progress.fail(err);
      else throw err;
    }
  } else if (action === "del") {
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("warn")} Удалить пак <b>${escapeHtml(pack.title)}</b> целиком? Действие не отменить.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🗑 Да, удалить", callback_data: `pk:${pack.id}:delyes` },
              { text: "Отмена", callback_data: `pk:${pack.id}:menu` },
            ],
          ],
        },
      }
    );
  } else if (action === "delyes") {
    await build.deletePack(pack);
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("trash")} Пак <b>${escapeHtml(pack.title)}</b> удалён.`
    );
  }
}

// ── Главный обработчик апдейтов ──────────────────────────────────────────────
async function handleMainUpdate(update) {
  if (update && update.pre_checkout_query) {
    await handlePreCheckout(update.pre_checkout_query);
    return;
  }
  if (update && update.callback_query) {
    const cqUser = update.callback_query.from && update.callback_query.from.id;
    const gate = spamGate(cqUser);
    if (gate === "blocked") return;
    if (gate === "warn") {
      await tg.answerCallbackQuery(config.botToken, update.callback_query.id).catch(() => {});
      await punishSpam(cqUser);
      return;
    }
    try {
      await handleCallback(update.callback_query);
    } catch (err) {
      console.error("[bot] callback error:", err.message);
      const uid = update.callback_query.from && update.callback_query.from.id;
      if (uid) {
        await tg
          .sendMessage(config.botToken, uid, `${e("warn")} Не получилось: ${escapeHtml(err.message)}`)
          .catch(() => {});
      }
    }
    return;
  }
  const msg = update && update.message;
  if (!msg || !msg.from) return;
  const userId = msg.from.id;
  db.touchUser(msg.from);
  if (msg.successful_payment) {
    await handleSuccessfulPayment(msg);
    return;
  }
  const gate = spamGate(userId);
  if (gate === "blocked") return;
  if (gate === "warn") {
    await punishSpam(userId);
    return;
  }
  const text = typeof msg.text === "string" ? msg.text.trim() : "";

  if (text === "/cancel") {
    db.clearPending(userId);
    await tg.sendMessage(config.botToken, userId, `${e("check2")} Отменил. Что дальше — /packs или редактор ниже.`, {
      reply_markup: webAppKeyboard(),
    });
    return;
  }

  // Команды отменяют незавершённый диалог, чтобы ввод не "залипал".
  if (text.startsWith("/") && text !== "/cancel") db.clearPending(userId);

  // Ожидающее действие (переименование/добавление/удаление) перехватывает ввод.
  const pending = db.getPending(userId);
  if (pending && pending.action) {
    try {
      const fileId = await extractAnimatedFileId(msg);
      if (fileId && pending.action === "add") {
        await handlePendingFile(userId, pending, fileId);
        return;
      }
      if (text && !text.startsWith("/")) {
        if (await handlePendingText(userId, pending, text)) return;
      }
    } catch (err) {
      console.error("[bot] pending action failed:", err.message);
      db.clearPending(userId);
      await tg
        .sendMessage(config.botToken, userId, `${e("warn")} Не получилось: ${escapeHtml(err.message)}`)
        .catch(() => {});
      return;
    }
  }

  if (text.startsWith("/start") || text.startsWith("/app") || text.startsWith("/help")) {
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("wave")} Привет! Это редактор кастомных эмодзи и стикеров ${e("cool")}\n\n` +
        `Как всё работает:\n` +
        `${e("right")} Открываешь редактор и собираешь пак\n` +
        `${e("right")} Жмёшь «Создать пак» — сборка идёт прямо здесь, с прогрессом ${e("timer")}\n` +
        `${e("right")} Готовый пак можно изменить, дополнить или удалить — /packs ${e("control")}\n\n` +
        `Цена: 1 стикер = 1 ⭐. Баланс и пополнение — /balance и /topup ${e("clap")}`,
      { reply_markup: webAppKeyboard() }
    );
    return;
  }
  if (text.startsWith("/packs")) {
    await sendPacksList(userId);
    return;
  }
  if (text.startsWith("/balance")) {
    await sendBalance(userId);
    return;
  }
  if (text.startsWith("/topup")) {
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("down")} <b>Пополнение баланса</b>\n1 стикер/эмодзи = 1 ⭐. Выбери сумму:`,
      { reply_markup: topupKeyboard() }
    );
    return;
  }
  if (text.startsWith("/stats")) {
    await sendStats(userId);
    return;
  }
  if (text.startsWith("/mailing")) {
    await startMailing(userId);
    return;
  }

  const fileId = await extractAnimatedFileId(msg);
  if (fileId) {
    await acceptUpload(userId, fileId);
    return;
  }
  if (msg.sticker || msg.document || msg.animation) {
    await tg.sendMessage(
      config.botToken,
      userId,
      `${e("sad")} Вижу файл, но мне нужен именно <b>анимированный</b> стикер/эмодзи (.tgs). ` +
        `Отправь premium emoji, animated sticker или файл .tgs.`
    );
  }
}

// Вебхук персонального бота: фиксируем /start владельца.
async function handlePackBotUpdate(ownerKey, secret, update) {
  const rec = db.getPackBot(ownerKey);
  if (!rec || rec.webhook_secret !== secret) return false;
  const msg = update && update.message;
  if (msg && msg.from && String(msg.from.id) === String(rec.owner_user_id)) {
    if (!rec.can_message_owner) db.setPackBotCanMessage(ownerKey);
    if (typeof msg.text === "string" && msg.text.startsWith("/start")) {
      await tg
        .sendMessage(rec.token, msg.from.id, `${e("check")} Готово! Теперь можно создавать паки из редактора.`)
        .catch(() => {});
    }
  }
  return true;
}

function newWebhookSecret() {
  return crypto.randomBytes(24).toString("hex");
}

module.exports = {
  formatRemaining,
  ANTISPAM,
  handleMainUpdate,
  handlePackBotUpdate,
  newWebhookSecret,
  runBuildWithProgress,
  storeUploadedTgs,
  EMOJI: e,
};
