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

function progressBar(done, total) {
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  const filled = Math.round(pct / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled) + ` ${pct}%`;
}

// ── Прогресс-сообщение в боте ────────────────────────────────────────────────
// Возвращает объект с update/done/fail или null, если писать некому.
async function startProgress(userId, title) {
  const token = config.botToken;
  if (!token) return null;
  let msg;
  try {
    msg = await tg.sendMessage(
      token,
      userId,
      `${e("timer")} <b>Загружаю…</b>\n${escapeHtml(title)}\n${progressBar(0, 1)}`
    );
  } catch (err) {
    console.warn("[bot] progress send failed:", err.message);
    return null;
  }
  const messageId = msg.message_id;
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
      await edit(
        `${e("timer")} <b>Загружаю…</b>\n${escapeHtml(title)}\n${label}: ${done}/${total}\n${progressBar(done, total)}`
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

// Сборка пака из мини-аппы: бот показывает прогресс и финальную карточку пака.
async function runBuildWithProgress(userId, job) {
  const progress = await startProgress(userId, `Собираю пак «${job.title}»`);
  try {
    const { pack, errors } = await build.createPack({
      ...job,
      userId,
      onProgress: progress ? (s, d, t) => progress.update(s, d, t) : undefined,
    });
    const packObj = db.getPack(pack.id);
    const warn = errors && errors.length ? `\n${e("warn")} Не влезло эмодзи: ${errors.length}` : "";
    const text =
      `${e("check")} <b>Пак готов!</b>\n` +
      `${e("doc")} <b>${escapeHtml(pack.title)}</b> · ${pack.count} шт.\n${pack.link}${warn}`;
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
  const progress = await startProgress(userId, progressTitle || `Добавляю в «${pack.title}»`);
  try {
    const { added, errors } = await build.addTiles(pack, tileIds, {}, progress
      ? (s, d, t) => progress.update(s, d, t)
      : undefined);
    const fresh = db.getPack(pack.id) || pack;
    const text =
      `${e("check")} <b>Готово!</b> Добавил: ${added.length}` +
      (errors.length ? `\n${e("warn")} Не получилось: ${errors.length}` : "") +
      `\n${e("doc")} <b>${escapeHtml(fresh.title)}</b> · теперь ${fresh.included.length} шт.\n${fresh.link}`;
    if (progress) await progress.done(text, packKeyboard(fresh));
    else await tg.sendMessage(config.botToken, userId, text, { reply_markup: packKeyboard(fresh) });
  } catch (err) {
    if (progress) await progress.fail(err);
    else throw err;
  }
}

async function handlePendingText(userId, pending, text) {
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

// ── Колбэки управления паками ────────────────────────────────────────────────
async function handleCallback(cq) {
  const userId = cq.from.id;
  const data = String(cq.data || "");
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
      const r = await build.convertPack(pack, userId);
      const text = `${e("repeat")} <b>Конвертация готова!</b>\nНовый формат: ${r.format === "sticker" ? "стикеры" : "эмодзи"}${r.parts > 1 ? `, паков: ${r.parts}` : ""}. Ссылки — в списке /packs`;
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
  if (update && update.callback_query) {
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
        `Всё бесплатно ${e("clap")}`,
      { reply_markup: webAppKeyboard() }
    );
    return;
  }
  if (text.startsWith("/packs")) {
    await sendPacksList(userId);
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
  handleMainUpdate,
  handlePackBotUpdate,
  newWebhookSecret,
  runBuildWithProgress,
  storeUploadedTgs,
  EMOJI: e,
};
