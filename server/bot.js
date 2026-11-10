"use strict";
// Обработка апдейтов: главный бот (вебхук /telegram/webhook) и персональные
// pack-боты юзеров (вебхук /telegram/webhook/pack/:userId).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const db = require("./db");
const catalog = require("./catalog");
const tg = require("./telegram");

function webAppKeyboard() {
  if (!config.publicUrl) return undefined;
  return {
    inline_keyboard: [
      [{ text: "🎨 Открыть редактор", web_app: { url: config.publicUrl } }],
    ],
  };
}

async function handleMainUpdate(update) {
  const msg = update && update.message;
  if (!msg || !msg.from) return;
  const userId = msg.from.id;
  const text = typeof msg.text === "string" ? msg.text : "";

  if (text.startsWith("/start") || text.startsWith("/app") || text.startsWith("/help")) {
    await tg.sendMessage(
      config.botToken,
      userId,
      "Привет! Это редактор кастомных эмодзи и стикеров.\n" +
        "Нажми кнопку ниже, собери пак — и я пришлю сюда ссылку на него.",
      { reply_markup: webAppKeyboard() }
    );
    return;
  }
  if (text.startsWith("/packs")) {
    const mine = db.state.packs.filter((p) => p.user_id === userId);
    await tg.sendMessage(
      config.botToken,
      userId,
      mine.length
        ? mine.map((p) => `• <b>${escapeHtml(p.title)}</b> — ${p.link}`).join("\n")
        : "Паков пока нет. Открой редактор и собери первый.",
      { reply_markup: webAppKeyboard() }
    );
    return;
  }

  // Загрузка своего эмодзи: нужен активный сеанс из мини-аппы («+» в редакторе).
  const fileId = await extractAnimatedFileId(msg);
  if (fileId) {
    await acceptUpload(userId, fileId);
    return;
  }
  if (msg.sticker || msg.document || msg.animation) {
    await tg.sendMessage(
      config.botToken,
      userId,
      "Вижу файл, но мне нужен именно <b>анимированный</b> стикер/эмодзи (.tgs). " +
        "Отправь premium emoji, animated sticker или файл .tgs."
    );
  }
}

async function extractAnimatedFileId(msg) {
  // Готовый анимированный стикер.
  if (msg.sticker && msg.sticker.is_animated) return msg.sticker.file_id;
  // .tgs файлом.
  if (
    msg.document &&
    (msg.document.file_name || "").toLowerCase().endsWith(".tgs")
  ) {
    return msg.document.file_id;
  }
  // Premium/custom emoji в тексте сообщения.
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const ce = entities.find((e) => e.type === "custom_emoji");
  if (ce && ce.custom_emoji_id && config.botToken) {
    try {
      const stickers = await tg.tgApi(config.botToken, "getCustomEmojiStickers", {
        custom_emoji_ids: [ce.custom_emoji_id],
      });
      const st = Array.isArray(stickers) && stickers[0];
      if (st && st.is_animated) return st.file_id;
    } catch (e) {
      console.warn("[bot] getCustomEmojiStickers failed:", e.message);
    }
  }
  return null;
}

async function acceptUpload(userId, fileId) {
  const session = db.state.uploadSessions[String(userId)];
  if (!session || session.expires_at < Date.now()) {
    await tg.sendMessage(
      config.botToken,
      userId,
      "Сначала нажми «+» в редакторе, а уже потом отправляй эмодзи сюда."
    );
    return;
  }
  try {
    const file = await tg.tgApi(config.botToken, "getFile", { file_id: fileId });
    const buf = await tg.tgDownload(config.botToken, file.file_path);
    // Проверка, что это правда gzip-Lottie, а не случайный файл.
    renderCheck(buf);
    const n = db.nextId("upload");
    const id = `upload:${n}`;
    const fileName = `${n}.tgs`;
    fs.mkdirSync(catalog.UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(catalog.UPLOAD_DIR, fileName), buf);
    db.state.uploadItems[id] = {
      id,
      file: fileName,
      user_id: userId,
      v: Math.floor(Date.now() / 1000),
    };
    session.status = "ready";
    session.upload_id = id;
    session.error = "";
    db.save();
    await tg.sendMessage(
      config.botToken,
      userId,
      "Принял! Возвращайся в редактор — эмодзи уже в каталоге."
    );
  } catch (e) {
    session.status = "error";
    session.error = "Не удалось принять файл: " + e.message;
    db.save();
    await tg
      .sendMessage(config.botToken, userId, "Не смог принять этот файл. Попробуй другой эмодзи.")
      .catch(() => {});
  }
}

function renderCheck(buf) {
  const zlib = require("zlib");
  const json = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
  if (!json || !Array.isArray(json.layers)) throw new Error("not a Lottie animation");
}

// Вебхук персонального бота: фиксируем /start владельца (иначе Telegram не
// даст создать стикерпак на его аккаунт этим ботом).
async function handlePackBotUpdate(ownerKey, secret, update) {
  const rec = db.state.packBots[String(ownerKey)];
  if (!rec || rec.webhook_secret !== secret) return false;
  const msg = update && update.message;
  if (msg && msg.from && String(msg.from.id) === String(rec.owner_user_id)) {
    if (!rec.can_message_owner) {
      rec.can_message_owner = true;
      db.save();
    }
    if (typeof msg.text === "string" && msg.text.startsWith("/start")) {
      await tg
        .sendMessage(rec.token, msg.from.id, "Готово! Теперь можно создавать паки из редактора.")
        .catch(() => {});
    }
  }
  return true;
}

function newWebhookSecret() {
  return crypto.randomBytes(24).toString("hex");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = { handleMainUpdate, handlePackBotUpdate, newWebhookSecret };
