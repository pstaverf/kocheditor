"use strict";
// Сборка паков: рендер выбранных тайлов replacer'ом -> загрузка в Telegram
// через бота юзера (если подключил своего) или главного бота приложения.
const config = require("./config");
const db = require("./db");
const catalog = require("./catalog");
const render = require("./render");
const tg = require("./telegram");

const STICKER_LIMIT = 120;
const EMOJI_LIMIT = 200;

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y",
  ь: "", э: "e", ю: "yu", я: "ya",
};

function slugify(text) {
  const s = String(text || "")
    .toLowerCase()
    .split("")
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
  return s || "pack";
}

// Глобал + per-tile override, как effectiveOverride() во фронте.
function effectiveOverride(id, global, perTile) {
  const g = global || {};
  const t = (perTile && perTile[String(id)]) || {};
  const isNew = catalog.isNewId(id);
  const ov = {
    kind: g.kind || "text",
    text: g.kind === "text" ? String(g.text || "") : "",
    logo_svg_b64: g.logo_svg_b64 || "",
    logo_png_b64: g.logo_png_b64 || "",
    content_color: "#ffffff",
    scale: 1,
    offset_x: 0,
    offset_y: 0,
    rotation: 0,
    anchor_x: null,
    anchor_y: null,
    replace_part: false,
    lines: null,
    photo_svg_b64: "",
    photo_png_b64: "",
    photo_scale: 1,
    photo_color: "#ffffff",
    letter_expand: isNew ? 2.5 : 1.0,
    allow_fallback: !isNew,
    font: g.font || render.DEFAULT_FONT_KEY,
    color_remap: null,
    text_gradient: null,
  };
  if (t && typeof t === "object") {
    for (const k of [
      "scale", "offset_x", "offset_y", "rotation", "content_color", "text_gradient",
      "color_remap", "lines", "photo_svg_b64", "photo_png_b64", "photo_scale",
      "photo_color", "anchor_x", "anchor_y", "replace_part", "font",
    ]) {
      if (t[k] !== undefined) ov[k] = t[k];
    }
    if (t.kind === "logo") {
      ov.kind = "logo";
      ov.text = "";
      ov.logo_svg_b64 = t.logo_svg_b64 || "";
      ov.logo_png_b64 = t.logo_png_b64 || "";
    } else if (t.kind === "text" || (typeof t.text === "string" && t.text.trim())) {
      ov.kind = "text";
      if (typeof t.text === "string" && t.text.trim()) ov.text = t.text;
      ov.logo_svg_b64 = "";
      ov.logo_png_b64 = "";
    }
  }
  // Паспорт: шапка (__header__) рулит текстом/цветом/масштабом.
  if (Array.isArray(ov.lines)) {
    const header = ov.lines.find((l) => l && l.name === "__header__");
    if (header && typeof header.text === "string" && header.text.trim()) {
      ov.kind = "text";
      ov.text = header.text;
      ov.content_color = header.color || "#000000";
      ov.scale = typeof header.scale === "number" ? header.scale : 1;
      ov.offset_x = header.offset_x || 0;
      ov.offset_y = header.offset_y || 0;
    }
  }
  if (ov.kind === "text" && !String(ov.text || "").trim()) ov.text = "Lean";
  return ov;
}

async function resolveBot(userId) {
  const own = db.getPackBot(userId);
  if (own && own.token) {
    return {
      token: own.token,
      username: own.bot_username,
      ownerId: Number(own.owner_user_id) || Number(userId),
      source: "user",
      canMessageOwner: !!own.can_message_owner,
    };
  }
  if (config.botToken) {
    const me = await tg.getMe(config.botToken);
    return {
      token: config.botToken,
      username: me.username,
      ownerId: Number(userId),
      source: "main",
      canMessageOwner: true,
    };
  }
  return null;
}

async function renderTiles(ids, global, perEmoji, errors, onProgress) {
  const out = [];
  let done = 0;
  for (const id of ids) {
    const buf = catalog.readTile(id);
    if (!buf) {
      errors.push({ id: String(id), error: "tile not found" });
    } else {
      try {
        const ov = effectiveOverride(id, global, perEmoji);
        const tgs = await render.renderTgs(buf, ov);
        out.push({ id, tgs });
      } catch (e) {
        errors.push({ id: String(id), error: String((e && e.message) || e) });
      }
    }
    done++;
    if (onProgress) await onProgress("render", done, ids.length);
  }
  return out;
}

function packName(title, userId, botUsername) {
  const rand = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  const suffix = `_${userId}_${rand}_by_${botUsername}`;
  let slug = slugify(title);
  if (!/^[a-z]/.test(slug)) slug = "pack_" + slug; // имя набора обязано начинаться с буквы
  return (slug.slice(0, Math.max(1, 64 - suffix.length)) + suffix).slice(0, 64);
}

function serializePack(pack) {
  const included = (pack.included || []).map((raw) =>
    /^\d+$/.test(String(raw)) ? Number(raw) : String(raw)
  );
  const split = { per_emoji: {}, new_per_emoji: {}, upload_per_emoji: {} };
  for (const [k, v] of Object.entries(pack.per_emoji || {})) {
    if (k.startsWith("new:")) split.new_per_emoji[k.slice(4)] = v;
    else if (k.startsWith("upload:")) split.upload_per_emoji[k.slice(7)] = v;
    else split.per_emoji[k] = v;
  }
  return {
    id: pack.id,
    title: pack.title,
    short_name: pack.short_name,
    link: pack.link,
    format: pack.format,
    pack_type: pack.format === "sticker" ? "stickers" : "emoji",
    count: included.length,
    cap: pack.format === "sticker" ? STICKER_LIMIT : EMOJI_LIMIT,
    included,
    global: pack.global || {},
    ...split,
    template_per_emoji: split.per_emoji,
    template_new_per_emoji: split.new_per_emoji,
    template_upload_per_emoji: split.upload_per_emoji,
    created_at: pack.created_at,
  };
}

// Пауза между вызовами загрузки/изменения стикеров: Telegram жёстко
// лимитит sticker-методы, без паузы прилетает "Too Many Requests".
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function paceUploads() {
  const ms = Number(config.stickerDelayMs) || 0;
  if (ms > 0) await sleep(ms);
}

async function createPack({ userId, title, format, ids, global, perEmoji, onProgress }) {
  const bot = await resolveBot(userId);
  if (!bot) {
    const e = new Error("pack bot not configured");
    e.needPackBot = true;
    throw e;
  }
  if (bot.source === "user" && !bot.canMessageOwner) {
    const e = new Error("pack bot needs /start");
    e.needPackBotStart = true;
    e.botUsername = bot.username;
    throw e;
  }
  const cap = format === "sticker" ? STICKER_LIMIT : EMOJI_LIMIT;
  const seenIds = new Set();
  const chosen = ids
    .filter((id) => {
      const k = String(id);
      if (seenIds.has(k)) return false;
      seenIds.add(k);
      return true;
    })
    .slice(0, cap);
  const errors = [];
  const rendered = await renderTiles(chosen, global, perEmoji, errors, onProgress);
  if (!rendered.length) {
    throw new Error(errors[0]?.error || "Не удалось отрендерить ни одного эмодзи");
  }
  const name = packName(title, userId, bot.username);
  const tgTitle = `${String(title || "Pack").slice(0, 40)} by @${config.publicPackBotUsername}`;
  const fileIds = [];
  let uploaded = 0;
  for (const r of rendered) {
    if (uploaded > 0) await paceUploads();
    fileIds.push(await tg.uploadStickerFile(bot.token, bot.ownerId, r.tgs));
    uploaded++;
    if (onProgress) await onProgress("upload", uploaded, rendered.length);
  }
  if (onProgress) await onProgress("create", rendered.length, rendered.length);
  await tg.createStickerSet(bot.token, {
    userId: bot.ownerId,
    name,
    title: tgTitle,
    stickerFileIds: fileIds,
    format,
  });
  const link =
    format === "sticker" ? `https://t.me/addstickers/${name}` : `https://t.me/addemoji/${name}`;
  const pack = {
    user_id: Number(userId),
    title: String(title || "Pack").slice(0, 40),
    short_name: name,
    link,
    format,
    included: rendered.map((r) => String(r.id)),
    global: global || {},
    per_emoji: perEmoji || {},
    bot_source: bot.source,
    created_at: new Date().toISOString(),
  };
  db.insertPack(pack);
  db.statsInc("packs_created", 1);
  db.statsInc("stickers_created", rendered.length);
  db.bumpUserMade(userId, 1, rendered.length);
  // Если сборку ведёт бот с прогрессом (onProgress), финальное сообщение он
  // покажет сам — не дублируем отдельным уведомлением.
  if (!onProgress) notify(bot, userId, `Пак готов: ${link}`).catch(() => {});
  return { pack: serializePack(pack), errors };
}

async function notify(bot, userId, text) {
  // Сначала бот, создавший пак; если он не может писать юзеру — главный бот.
  try {
    await tg.sendMessage(bot.token, bot.ownerId, text);
    return;
  } catch (_) {}
  if (config.botToken && bot.token !== config.botToken) {
    await tg.sendMessage(config.botToken, userId, text);
  }
}

async function botForPack(pack) {
  if (pack.bot_source === "user") {
    const own = db.getPackBot(pack.user_id);
    if (own && own.token) {
      return { token: own.token, username: own.bot_username, ownerId: Number(own.owner_user_id) || pack.user_id };
    }
    throw new Error("Бот, создавший пак, отключён. Подключи его снова во вкладке редактора.");
  }
  if (!config.botToken) throw new Error("Главный бот не настроен на сервере");
  const me = await tg.getMe(config.botToken);
  return { token: config.botToken, username: me.username, ownerId: pack.user_id };
}

async function addTiles(pack, tileIds, overrides, onProgress) {
  const bot = await botForPack(pack);
  const perEmoji = { ...(pack.per_emoji || {}) };
  for (const [k, v] of Object.entries(overrides || {})) perEmoji[String(k)] = v;
  const errors = [];
  const cap = pack.format === "sticker" ? STICKER_LIMIT : EMOJI_LIMIT;
  const includedSet = new Set((pack.included || []).map(String));
  const seenAdd = new Set();
  const queue = (tileIds || [])
    .map(String)
    .filter((id) => {
      if (seenAdd.has(id) || includedSet.has(id)) return false;
      seenAdd.add(id);
      return true;
    })
    .slice(0, Math.max(0, cap - includedSet.size));
  const rendered = await renderTiles(queue, pack.global, perEmoji, errors, onProgress);
  const added = [];
  let addedIx = 0;
  for (const r of rendered) {
    try {
      if (addedIx > 0) await paceUploads();
      addedIx++;
      const fileId = await tg.uploadStickerFile(bot.token, bot.ownerId, r.tgs);
      await tg.addSticker(bot.token, { userId: bot.ownerId, name: pack.short_name, stickerFileId: fileId });
      added.push(r.id);
      pack.included.push(String(r.id));
      if (overrides && overrides[String(r.id)]) pack.per_emoji[String(r.id)] = overrides[String(r.id)];
    } catch (e) {
      errors.push({ id: String(r.id), error: String((e && e.message) || e) });
    }
  }
  db.updatePack(pack);
  if (added.length) {
    db.statsInc("stickers_created", added.length);
    db.bumpUserMade(pack.user_id, 0, added.length);
  }
  return { added, errors };
}

async function renamePack(pack, title) {
  const bot = await botForPack(pack);
  const tgTitle = `${title} by @${config.publicPackBotUsername}`;
  try {
    await tg.setStickerSetTitle(bot.token, pack.short_name, tgTitle);
  } catch (e) {
    // Название в Telegram может не примениться (например, пак чужого бота) —
    // локально всё равно переименовываем, фронт показывает наше имя.
    console.warn("[packs] setStickerSetTitle failed:", e.message);
  }
  pack.title = title;
  db.updatePack(pack);
  return pack;
}

async function convertPack(pack, userId) {
  const target = pack.format === "sticker" ? "emoji" : "sticker";
  const ids = (pack.included || []).slice();
  const cap = target === "sticker" ? STICKER_LIMIT : EMOJI_LIMIT;
  const parts = Math.max(1, Math.ceil(ids.length / cap));
  for (let i = 0; i < parts; i++) {
    const chunk = ids.slice(i * cap, (i + 1) * cap);
    const suffix = parts > 1 ? ` ${i + 1}` : "";
    await createPack({
      userId,
      title: (pack.title || "Pack") + suffix,
      format: target,
      ids: chunk,
      global: pack.global,
      perEmoji: pack.per_emoji,
    });
  }
  return { parts, format: target };
}

// Убрать эмодзи из пака по позициям (1-based, как в списке included).
async function removeTiles(pack, positions) {
  const bot = await botForPack(pack);
  const set = await tg.tgApi(bot.token, "getStickerSet", { name: pack.short_name });
  const stickers = (set && set.stickers) || [];
  const targets = [...new Set(positions)]
    .filter((n) => n >= 1 && n <= pack.included.length)
    .sort((a, b) => b - a);
  const removed = [];
  for (const pos of targets) {
    const sticker = stickers[pos - 1];
    if (!sticker) continue;
    if (removed.length > 0) await paceUploads();
    await tg.tgApi(bot.token, "deleteStickerFromSet", { sticker_file_id: sticker.file_id });
    removed.push(pack.included[pos - 1]);
    pack.included.splice(pos - 1, 1);
  }
  db.updatePack(pack);
  return removed;
}

// Удалить пак целиком (в Telegram и у нас).
async function deletePack(pack) {
  const bot = await botForPack(pack);
  await tg.tgApi(bot.token, "deleteStickerSet", { name: pack.short_name });
  db.deletePack(pack.id);
}

module.exports = {
  STICKER_LIMIT,
  EMOJI_LIMIT,
  slugify,
  packName,
  effectiveOverride,
  resolveBot,
  botForPack,
  notify,
  serializePack,
  createPack,
  addTiles,
  removeTiles,
  deletePack,
  renamePack,
  convertPack,
};
