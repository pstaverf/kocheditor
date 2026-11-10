"use strict";
// kocheditor backend: статика WebApp + JSON API + вебхуки ботов на одном домене.
// Запуск: BOT_TOKEN=... PUBLIC_URL=https://domain node server/index.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const db = require("./db");
const tg = require("./telegram");
const catalog = require("./catalog");
const render = require("./render");
const build = require("./build");
const bot = require("./bot");
const { stickerQueue } = require("./queue");

db.open();
catalog.scan();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8"));
}

// ── Авторизация WebApp ───────────────────────────────────────────────────────
function authUser(req, res) {
  const initData = req.headers["x-telegram-init-data"] || "";
  if (config.botToken && initData) {
    const valid = tg.validateInitData(initData, config.botToken);
    if (valid && valid.user) {
      db.touchUser(valid.user);
      return valid.user;
    }
  }
  if (config.allowUnauth) {
    const unsafe = tg.parseInitDataUnsafe(initData);
    const user = unsafe || { id: 1, first_name: "Dev" };
    db.touchUser(user);
    return user;
  }
  sendError(res, 401, "Открой редактор через Telegram");
  return null;
}

function serveFile(res, absPath, cacheControl) {
  fs.readFile(absPath, (err, data) => {
    if (err) return sendError(res, 404, "not found");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(absPath).toLowerCase()] || "application/octet-stream",
      "Content-Length": data.length,
      ...(cacheControl ? { "Cache-Control": cacheControl } : {}),
    });
    res.end(data);
  });
}

function safeName(raw) {
  let decoded = String(raw || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch (_) {
    return null;
  }
  const name = path.basename(decoded);
  if (!name || name.includes("..")) return null;
  return name;
}

// ── Роуты API ────────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // Каталоги и файлы тайлов (публичные — фронт грузит их без initData).
  if (method === "GET" && p === "/api/master/list") return sendJson(res, 200, catalog.masterList());
  if (method === "GET" && p === "/api/new/list") return sendJson(res, 200, catalog.newList());
  let m;
  if (method === "GET" && (m = p.match(/^\/api\/(master|new)\/([^/]+)$/))) {
    const name = safeName(m[2]);
    const dir = m[1] === "master" ? catalog.MASTER_DIR : catalog.NEW_DIR;
    if (!name || !name.endsWith(".tgs")) return sendError(res, 404, "not found");
    return serveFile(res, path.join(dir, name), "public, max-age=86400");
  }
  if (method === "GET" && (m = p.match(/^\/api\/new_preview\/([^/]+)$/))) {
    const name = safeName(m[1]);
    if (!name) return sendError(res, 404, "not found");
    return serveFile(res, path.join(catalog.NEW_PREVIEW_DIR, name), "public, max-age=86400");
  }
  if (method === "GET" && p === "/api/uploads/list") {
    const user = authUser(req, res);
    if (!user) return;
    return sendJson(res, 200, catalog.uploadList(user.id));
  }
  if (
    method === "GET" &&
    (m = p.match(/^\/api\/uploads\/([^/]+)$/)) &&
    !["list", "status", "start", "cancel"].includes(m[1])
  ) {
    const user = authUser(req, res);
    if (!user) return;
    const name = safeName(m[1]);
    const item = name ? db.findUploadItem(user.id, name) : null;
    if (!item) return sendError(res, 404, "not found");
    return serveFile(res, path.join(catalog.UPLOAD_DIR, item.file), "private, max-age=3600");
  }

  // Шрифты.
  if (method === "GET" && p === "/api/fonts/list") {
    return sendJson(
      res,
      200,
      render.FONTS.map((f) => ({
        key: f.key,
        label: f.label,
        sample: f.sample,
        url: `/api/fonts/${f.key}`,
      }))
    );
  }
  if (method === "GET" && p === "/api/fonts/fallbacks") {
    return sendJson(res, 200, [
      {
        key: "russo",
        label: "Russo One",
        url: "/api/fonts/russo",
        ranges: [[0x400, 0x4ff], [0x500, 0x52f]],
        default: true,
      },
    ]);
  }
  if (method === "GET" && (m = p.match(/^\/api\/fonts\/([a-z0-9_-]+)$/i))) {
    if (!render.FONTS.some((f) => f.key === m[1].toLowerCase())) {
      return sendError(res, 404, "font not found");
    }
    const fontPath = render.fontPath(m[1]);
    if (!fs.existsSync(fontPath)) return sendError(res, 404, "font not found");
    return serveFile(res, fontPath, "public, max-age=604800");
  }

  if (method === "GET" && p === "/api/pricing") {
    return sendJson(res, 200, { ...config.pricing, star_per_sticker: config.starPerSticker || 1 });
  }

  // PNG-логотип: сервер вставляет растр в Lottie, фронт докладывает остальной override.
  if (method === "POST" && p === "/api/png_preview") {
    const body = await readJson(req).catch(() => null);
    if (!body || !body.id || !body.logo_png_b64) return sendError(res, 400, "id и logo_png_b64 обязательны");
    const buf = catalog.readTile(body.id);
    if (!buf) return sendError(res, 404, "tile not found");
    try {
      const json = render.gunzipJson(buf);
      const animation = await render.applyOverride(json, {
        kind: "logo",
        logo_png_b64: String(body.logo_png_b64),
        scale: +body.scale || 1,
        offset_x: +body.offset_x || 0,
        offset_y: +body.offset_y || 0,
        rotation: 0,
        font: render.DEFAULT_FONT_KEY,
        letter_expand: catalog.isNewId(body.id) ? 2.5 : 1.0,
        allow_fallback: !catalog.isNewId(body.id),
      });
      return sendJson(res, 200, { animation });
    } catch (e) {
      return sendError(res, 500, String((e && e.message) || e));
    }
  }

  // ── Дальше только с initData ──
  if (p === "/api/pack_bot/save" && method === "POST") {
    const user = authUser(req, res);
    if (!user) return;
    const body = await readJson(req).catch(() => ({}));
    const token = String(body.bot_token || "").trim();
    const ownerId = String(body.owner_user_id || "").trim();
    if (!/^\d+:[\w-]{20,}$/.test(token)) return sendError(res, 400, "Похоже, это не Bot API token");
    if (!/^\d+$/.test(ownerId)) return sendError(res, 400, "Owner user ID должен быть числом");
    let me;
    try {
      me = await tg.tgApi(token, "getMe");
    } catch (e) {
      return sendError(res, 400, "Telegram отклонил токен: " + e.message);
    }
    const secret = bot.newWebhookSecret();
    const rec = {
      token,
      bot_id: me.id,
      bot_username: me.username,
      owner_user_id: ownerId,
      webhook_secret: secret,
      can_message_owner: false,
    };
    db.setPackBot(user.id, rec);
    // Свой вебхук персональному боту — чтобы ловить /start владельца.
    if (config.publicUrl) {
      tg.setBotWebhook(
        token,
        `${config.publicUrl}/telegram/webhook/pack/${encodeURIComponent(user.id)}?s=${secret}`,
        secret
      ).catch((e) => console.warn("[pack_bot] setWebhook failed:", e.message));
    } else {
      console.warn("[pack_bot] PUBLIC_URL не задан — вебхук персонального бота не поставлен, /start не отследим");
    }
    return sendJson(res, 200, packBotPayload(rec));
  }

  if (p === "/api/pack_bot/delete" && method === "POST") {
    const user = authUser(req, res);
    if (!user) return;
    const rec = db.getPackBot(user.id);
    if (rec) {
      tg.tgApi(rec.token, "deleteWebhook").catch(() => {});
      db.deletePackBot(user.id);
    }
    return sendJson(res, 200, { configured: false });
  }

  if (p === "/api/pack_bot/status" && method === "GET") {
    const user = authUser(req, res);
    if (!user) return;
    const rec = db.getPackBot(user.id);
    return sendJson(res, 200, rec ? packBotPayload(rec) : { configured: false });
  }

  if (p === "/api/uploads/start" && method === "POST") {
    const user = authUser(req, res);
    if (!user) return;
    db.setUploadSession(user.id, {
      status: "waiting",
      expires_at: Date.now() + 10 * 60 * 1000,
      upload_id: null,
      error: "",
    });
    return sendJson(res, 200, { ok: true, status: "waiting" });
  }
  if (p === "/api/uploads/status" && method === "GET") {
    const user = authUser(req, res);
    if (!user) return;
    const s = db.getUploadSession(user.id);
    if (!s) return sendJson(res, 200, { status: "idle" });
    if (s.status === "waiting" && s.expires_at < Date.now()) {
      return sendJson(res, 200, { status: "expired", error: "Время вышло. Нажми «+» ещё раз." });
    }
    const out = { status: s.status, error: s.error || "" };
    if (s.status === "ready" && s.upload_id) {
      const item = db.getUploadItem(s.upload_id);
      if (item) out.upload = { id: item.id, file: item.file, v: item.v };
    }
    return sendJson(res, 200, out);
  }
  if (p === "/api/uploads/cancel" && method === "POST") {
    const user = authUser(req, res);
    if (!user) return;
    db.deleteUploadSession(user.id);
    return sendJson(res, 200, { ok: true });
  }

  if (p === "/api/profile" && method === "GET") {
    const user = authUser(req, res);
    if (!user) return;
    const row = db.getUser(user.id) || {};
    const packs = db.listPacks(user.id);
    return sendJson(res, 200, {
      id: Number(user.id),
      first_name: row.first_name || user.first_name || "",
      username: row.username || user.username || "",
      balance_stars: db.getBalance(user.id),
      total_topup_stars: row.total_topup_stars || 0,
      packs_count: packs.length,
      packs_made: row.packs_made || 0,
      stickers_made: row.stickers_made || 0,
      star_per_sticker: config.starPerSticker || 1,
      is_admin: bot.isAdmin(user.id),
    });
  }

  if (p === "/api/billing/invoice" && method === "POST") {
    const user = authUser(req, res);
    if (!user) return;
    const body = await readJson(req).catch(() => ({}));
    const amount = Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
      return sendError(res, 400, "Сумма пополнения — от 1 до 500 ⭐");
    }
    if (!config.botToken) return sendError(res, 503, "Бот не настроен на сервере");
    try {
      const url = await tg.tgApi(config.botToken, "createInvoiceLink", {
        title: "Пополнение баланса",
        description: `${amount} Telegram Stars = ${amount} стикеров/эмодзи в редакторе`,
        payload: `topup:${user.id}:${amount}:${Date.now().toString(36)}`,
        currency: "XTR",
        prices: [{ label: `${amount} Telegram Stars`, amount }],
      });
      return sendJson(res, 200, { invoice_url: url, amount });
    } catch (e) {
      return sendError(res, 502, "Telegram не создал счёт: " + e.message);
    }
  }

  if (p === "/api/build_pack" && method === "POST") {
    const user = authUser(req, res);
    if (!user) return;
    const body = await readJson(req).catch(() => null);
    if (!body) return sendError(res, 400, "bad json");
    const format = body.format === "sticker" ? "sticker" : "emoji";
    const ids = Array.isArray(body.selected) ? body.selected.map(String) : [];
    if (!ids.length) return sendError(res, 400, "Выбери хотя бы один стикер");
    const cap = format === "sticker" ? build.STICKER_LIMIT : build.EMOJI_LIMIT;
    if (ids.length > cap) return sendError(res, 400, `Слишком много — максимум ${cap}`);
    // Быстрые проверки до запуска фоновой сборки (фронт умеет эти ответы).
    const botInfo = await build.resolveBot(user.id).catch(() => null);
    if (!botInfo) return sendJson(res, 403, { need_pack_bot: true, error: "Добавь бота для создания паков" });
    if (botInfo.source === "user" && !botInfo.canMessageOwner) {
      return sendJson(res, 403, {
        need_pack_bot_start: true,
        bot_username: botInfo.username,
        owner_user_id: String(user.id),
        error: "Нажми /start в своём боте",
      });
    }
    const neededStars = Math.min(new Set(ids).size, cap) * (config.starPerSticker || 1);
    const balanceStars = db.getBalance(user.id);
    if (!bot.isAdmin(user.id) && balanceStars < neededStars) {
      return sendJson(res, 402, {
        need_stars: true,
        needed: neededStars,
        balance: balanceStars,
        error: `Не хватает ⭐: нужно ${neededStars}, на балансе ${balanceStars}`,
      });
    }
    const job = {
      userId: user.id,
      title: String(body.pack_title || "Pack").slice(0, 40) || "Pack",
      format,
      ids,
      global: body.global || {},
      perEmoji: body.per_emoji || {},
    };
    // Сборку ведёт бот: он пришлёт «Загружаю…» с прогрессом и карточку пака.
    // Запрос не держим — фронт покажет «Перейдите к боту» и закроется.
    setImmediate(async () => {
      try {
        const pack = await bot.runBuildWithProgress(user.id, job);
        console.log(`[build] pack ${pack.short_name} for user ${user.id}`);
      } catch (e) {
        console.error("[build] failed for user", user.id, e.message);
      }
    });
    return sendJson(res, 200, {
      ok: true,
      queued: true,
      bot_username: botInfo.username || "",
      go_to_bot: true,
    });
  }

  if (p === "/api/packs/list" && method === "GET") {
    const user = authUser(req, res);
    if (!user) return;
    const mine = db.listPacks(user.id).map(build.serializePack);
    return sendJson(res, 200, mine);
  }

  if ((m = p.match(/^\/api\/packs\/(\d+)$/)) && method === "GET") {
    const user = authUser(req, res);
    if (!user) return;
    const pack = findOwnPack(user, Number(m[1]));
    if (!pack) return sendError(res, 404, "Пак не найден");
    return sendJson(res, 200, build.serializePack(pack));
  }
  if ((m = p.match(/^\/api\/packs\/(\d+)\/rename$/)) && method === "POST") {
    const user = authUser(req, res);
    if (!user) return;
    const pack = findOwnPack(user, Number(m[1]));
    if (!pack) return sendError(res, 404, "Пак не найден");
    const body = await readJson(req).catch(() => ({}));
    const title = String(body.title || "").trim().slice(0, 40);
    if (!title) return sendError(res, 400, "Пустое название");
    try {
      await build.renamePack(pack, title);
      return sendJson(res, 200, { title: pack.title });
    } catch (e) {
      return sendError(res, 502, e.message);
    }
  }
  if ((m = p.match(/^\/api\/packs\/(\d+)\/add_tiles$/)) && method === "POST") {
    const user = authUser(req, res);
    if (!user) return;
    const pack = findOwnPack(user, Number(m[1]));
    if (!pack) return sendError(res, 404, "Пак не найден");
    const body = await readJson(req).catch(() => ({}));
    const tileIds = Array.isArray(body.tile_ids) ? body.tile_ids.map(String) : [];
    if (!tileIds.length) return sendError(res, 400, "tile_ids пуст");
    const includedSet = new Set((pack.included || []).map(String));
    const wantAdd = [...new Set(tileIds)].filter((id) => !includedSet.has(id)).length;
    const needAdd = wantAdd * (config.starPerSticker || 1);
    if (!bot.isAdmin(user.id) && db.getBalance(user.id) < needAdd) {
      return sendJson(res, 402, {
        need_stars: true,
        needed: needAdd,
        balance: db.getBalance(user.id),
        error: `Не хватает ⭐: нужно ${needAdd}, на балансе ${db.getBalance(user.id)}`,
      });
    }
    try {
      const r = await stickerQueue.enqueue(
        { userId: user.id, kind: "add", label: pack.title || "пак" },
        () => build.addTiles(pack, tileIds, body.overrides || {})
      );
      if (!bot.isAdmin(user.id) && r.added && r.added.length) {
        db.debitStars(user.id, r.added.length * (config.starPerSticker || 1));
      }
      return sendJson(res, 200, r);
    } catch (e) {
      return sendError(res, 502, e.message);
    }
  }
  if ((m = p.match(/^\/api\/packs\/(\d+)\/convert$/)) && method === "POST") {
    const user = authUser(req, res);
    if (!user) return;
    const pack = findOwnPack(user, Number(m[1]));
    if (!pack) return sendError(res, 404, "Пак не найден");
    const target = pack.format === "sticker" ? "emoji" : "sticker";
    const cap = target === "sticker" ? build.STICKER_LIMIT : build.EMOJI_LIMIT;
    const parts = Math.max(1, Math.ceil((pack.included || []).length / cap));
    const needConvert = (pack.included || []).length * (config.starPerSticker || 1);
    if (!bot.isAdmin(user.id) && db.getBalance(user.id) < needConvert) {
      return sendJson(res, 402, {
        need_stars: true,
        needed: needConvert,
        balance: db.getBalance(user.id),
        error: `Не хватает ⭐: нужно ${needConvert}, на балансе ${db.getBalance(user.id)}`,
      });
    }
    setImmediate(async () => {
      try {
        await build.convertPack(pack, user.id);
        if (!bot.isAdmin(user.id)) db.debitStars(user.id, needConvert);
        console.log(`[convert] pack ${pack.id} -> ${target} for user ${user.id}`);
      } catch (e) {
        console.error("[convert] failed for pack", pack.id, e.message);
        if (config.botToken) {
          tg.sendMessage(config.botToken, user.id, "Не удалось сконвертировать пак: " + e.message).catch(() => {});
        }
      }
    });
    return sendJson(res, 200, { ok: true, parts, format: target });
  }

  return sendError(res, 404, "unknown endpoint");
}

function packBotPayload(rec) {
  const masked = rec.token ? rec.token.slice(0, rec.token.indexOf(":") + 4) + "…" : "";
  return {
    configured: true,
    bot_username: rec.bot_username,
    bot_id: rec.bot_id,
    owner_user_id: rec.owner_user_id,
    token_mask: masked,
    can_message_owner: !!rec.can_message_owner,
    needs_start: !rec.can_message_owner,
  };
}

function findOwnPack(user, id) {
  return db.getPackForUser(id, user.id);
}

// ── Вебхуки ──────────────────────────────────────────────────────────────────
async function handleWebhook(req, res, url) {
  const raw = await readBody(req, 4 * 1024 * 1024);
  let update = {};
  try {
    update = JSON.parse(raw.toString("utf8") || "{}");
  } catch (_) {}
  // Telegram ждёт быстрый 200, обработку ошибок только логируем.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
  try {
    if (url.pathname === "/telegram/webhook") {
      if (config.webhookSecret) {
        const secret = req.headers["x-telegram-bot-api-secret-token"];
        if (secret !== config.webhookSecret) return;
      }
      if (config.botToken) await bot.handleMainUpdate(update);
    } else {
      const m = url.pathname.match(/^\/telegram\/webhook\/pack\/([^/]+)$/);
      if (m) await bot.handlePackBotUpdate(decodeURIComponent(m[1]), url.searchParams.get("s") || "", update);
    }
  } catch (e) {
    console.error("[webhook] handler error:", e.message);
  }
}

// ── HTTP-сервер ──────────────────────────────────────────────────────────────
const STATIC_FILES = new Set([
  "index.html", "app.js", "replacer.js", "style.css", "icons.html",
  "lottie.min.js", "opentype.min.js", "pako.min.js", "swex-loader-lockup.png",
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    if (p === "/healthz") return sendJson(res, 200, { ok: true });
    if (p === "/" || p === "/index.html") {
      return serveFile(res, path.join(config.ROOT, "index.html"), "no-cache");
    }
    if (p.startsWith("/static/")) {
      const name = safeName(p.slice("/static/".length));
      if (!name || !STATIC_FILES.has(name)) return sendError(res, 404, "not found");
      // Код/стили/разметку не кэшируем: в Telegram WebView закэшированный
      // app.js однажды уже "убил" новую вкладку. Картинки — с кэшем.
      const cache = /\.(?:js|css|html)$/i.test(name) ? "no-cache" : "public, max-age=3600";
      return serveFile(res, path.join(config.ROOT, name), cache);
    }
    if (p.startsWith("/api/")) return await handleApi(req, res, url);
    if (p === "/telegram/webhook" || p.startsWith("/telegram/webhook/")) {
      return await handleWebhook(req, res, url);
    }
    return sendError(res, 404, "not found");
  } catch (e) {
    console.error("[http]", e);
    if (!res.headersSent) sendError(res, 500, "internal error");
  }
});

server.listen(config.port, config.host, async () => {
  console.log(`[kocheditor] http://${config.host}:${config.port}`);
  console.log(
    `[env] BOT_TOKEN=${config.botToken ? "задан" : "НЕ задан"} ` +
      `PUBLIC_URL=${config.publicUrl || "НЕ задан"} ` +
      `WEBHOOK_SECRET=${config.webhookSecret ? "задан" : "не задан"}`
  );
  catalog.computeMeta();
  if (config.botToken && config.publicUrl) {
    try {
      const me = await tg.getMe(config.botToken);
      await tg.setBotWebhook(
        config.botToken,
        `${config.publicUrl}/telegram/webhook`,
        config.webhookSecret || undefined
      );
      await tg
        .tgApi(config.botToken, "setMyCommands", {
          commands: [
            { command: "start", description: "Открыть редактор" },
            { command: "packs", description: "Мои паки" },
            { command: "balance", description: "Баланс ⭐" },
            { command: "topup", description: "Пополнить баланс" },
            { command: "stats", description: "Статистика (админ)" },
            { command: "mailing", description: "Рассылка (админ)" },
          ],
        })
        .catch(() => {});
      await tg
        .tgApi(config.botToken, "setChatMenuButton", {
          menu_button: { type: "web_app", text: "Редактор", web_app: { url: config.publicUrl } },
        })
        .catch(() => {});
      console.log(`[bot] @${me.username} webhook -> ${config.publicUrl}/telegram/webhook`);
    } catch (e) {
      console.error("[bot] webhook setup failed:", e.message);
    }
  } else if (!config.botToken) {
    console.warn("[bot] BOT_TOKEN не задан — бот и проверка initData отключены (dev-режим)");
  } else {
    console.warn("[bot] PUBLIC_URL не задан — вебхук не поставлен. Поставь вручную на /telegram/webhook");
  }
});
