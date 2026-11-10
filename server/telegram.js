"use strict";
// Минимальный клиент Telegram Bot API + валидация WebApp initData.
const crypto = require("crypto");

class TgError extends Error {
  constructor(message, code, retryAfter) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter || 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tgApi(token, method, params = {}, files = null) {
  let body;
  const headers = {};
  if (files) {
    body = new FormData();
    for (const [k, v] of Object.entries(params)) {
      body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    for (const [k, f] of Object.entries(files)) {
      body.append(k, new Blob([f.buffer], { type: f.type || "application/octet-stream" }), f.name);
    }
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(params);
  }
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers,
      body,
    });
    const data = await r.json().catch(() => ({}));
    if (data.ok) return data.result;
    const retryAfter =
      (data.parameters && data.parameters.retry_after) || (r.status === 429 ? 2 : 0);
    lastError = new TgError(
      data.description || `Telegram ${method} failed (${r.status})`,
      data.error_code,
      retryAfter
    );
    // Flood control: ждём, сколько просит Telegram, и повторяем.
    if (retryAfter && attempt < 3) {
      await sleep(Math.min(retryAfter, 15) * 1000);
      continue;
    }
    throw lastError;
  }
  throw lastError;
}

async function tgDownload(token, filePath) {
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!r.ok) throw new TgError(`download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

// ── WebApp initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
function validateInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = +(params.get("auth_date") || 0);
  // Подписанные, но протухшие initData не принимаем (защита от реплея).
  if (!authDate || Date.now() / 1000 - authDate > 24 * 3600) return null;
  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (_) {}
  return { user, authDate };
}

// Небезопасный разбор user из initData — только для dev-режима без токена.
function parseInitDataUnsafe(initData) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    return JSON.parse(params.get("user") || "null");
  } catch (_) {
    return null;
  }
}

const meCache = new Map();
async function getMe(token) {
  if (!meCache.has(token)) meCache.set(token, await tgApi(token, "getMe"));
  return meCache.get(token);
}

async function setBotWebhook(token, url, secret) {
  const params = { url, allowed_updates: ["message", "callback_query", "pre_checkout_query"] };
  if (secret) params.secret_token = secret;
  return tgApi(token, "setWebhook", params);
}

async function sendMessage(token, chatId, text, extra = {}) {
  return tgApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

// ── Стикер-паки ──────────────────────────────────────────────────────────────
async function editMessageText(token, chatId, messageId, text, extra = {}) {
  return tgApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function answerCallbackQuery(token, callbackQueryId, text) {
  return tgApi(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

async function uploadStickerFile(token, userId, tgsBuffer) {
  const res = await tgApi(
    token,
    "uploadStickerFile",
    { user_id: userId, sticker_format: "animated" },
    { sticker: { buffer: tgsBuffer, name: "sticker.tgs", type: "application/octet-stream" } }
  );
  return res.file_id;
}

async function createStickerSet(token, { userId, name, title, stickerFileIds, format }) {
  const stickers = stickerFileIds.map((fileId) => ({
    sticker: fileId,
    format: "animated",
    emoji_list: ["🔥"],
  }));
  return tgApi(token, "createNewStickerSet", {
    user_id: userId,
    name,
    title,
    stickers,
    sticker_type: format === "sticker" ? "regular" : "custom_emoji",
  });
}

async function addSticker(token, { userId, name, stickerFileId }) {
  return tgApi(token, "addStickerToSet", {
    user_id: userId,
    name,
    sticker: { sticker: stickerFileId, format: "animated", emoji_list: ["🔥"] },
  });
}

async function setStickerSetTitle(token, name, title) {
  return tgApi(token, "setStickerSetTitle", { name, title });
}

module.exports = {
  TgError,
  tgApi,
  tgDownload,
  validateInitData,
  parseInitDataUnsafe,
  getMe,
  setBotWebhook,
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  uploadStickerFile,
  createStickerSet,
  addSticker,
  setStickerSetTitle,
};
