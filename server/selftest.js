"use strict";
// Дымовой тест без Telegram: поднимает сервер на случайном порту в dev-режиме
// и проверяет каталог, шрифты, цены, png_preview, рендер TGS и фолбэк build_pack.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

process.env.DATA_DIR = process.env.DATA_DIR || require("os").tmpdir() + "/kocheditor-selftest-" + process.pid;
process.env.BOT_TOKEN = "111:fake-test-token";
process.env.PUBLIC_URL = "https://example.test";
const ROOT = path.resolve(__dirname, "..");
const PORT = 18000 + Math.floor(Math.random() * 900);

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start");
}

function assert(cond, msg) {
  if (!cond) throw new Error("assert failed: " + msg);
  console.log("  ok:", msg);
}

(async () => {
  // 0) Бот: фейковый Telegram API, весь цикл управления паком.
  {
    const calls = [];
    const sets = new Map();
    let msgSeq = 100;
    const realFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      const m = u.match(/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
      assert(m, "бот ходит только в Telegram API: " + u);
      const method = m[1];
      let params = {};
      try { params = JSON.parse(opts.body || "{}"); } catch (_) {}
      calls.push({ method, params });
      const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
      switch (method) {
        case "getMe": return ok({ id: 1, username: "mainbot", first_name: "Main" });
        case "sendMessage": return ok({ message_id: ++msgSeq, chat: { id: params.chat_id } });
        case "editMessageText": return ok(true);
        case "answerCallbackQuery": return ok(true);
        case "uploadStickerFile": return ok({ file_id: "file" + Math.floor(Math.random() * 1e9) });
        case "createNewStickerSet":
          sets.set(params.name, params.stickers.map((s) => s.sticker));
          return ok(true);
        case "addStickerToSet":
          sets.get(params.name).push(params.sticker.sticker);
          return ok(true);
        case "getStickerSet":
          return ok({ name: params.name, stickers: (sets.get(params.name) || []).map((f) => ({ file_id: f })) });
        case "deleteStickerFromSet": {
          const arr = sets.get([...sets.keys()][0]) || [];
          const ix = arr.indexOf(params.sticker_file_id);
          if (ix >= 0) arr.splice(ix, 1);
          return ok(true);
        }
        case "setStickerSetTitle": return ok(true);
        case "deleteStickerSet": sets.delete(params.name); return ok(true);
        default: return ok(true);
      }
    };
    try {
      const bot = require("./bot");
      require("./catalog").scan();
      const db = require("./db");
      db.open();
      const userId = 4242;
      const msg = (text) => ({ update_id: 1, message: { message_id: 1, from: { id: userId }, chat: { id: userId }, text } });
      const cb = (data) => ({ update_id: 2, callback_query: { id: "q1", from: { id: userId }, data } });

      await bot.handleMainUpdate(msg("/start"));
      const startText = calls.find((c) => c.method === "sendMessage").params.text;
      assert(startText.includes('tg-emoji emoji-id="5339517760592421605"'), "бот: /start с кастомным эмодзи");

      const pack = await bot.runBuildWithProgress(userId, {
        title: "Тестовый", format: "emoji", ids: [3],
        global: { kind: "text", text: "HELLO", font: "russo" }, perEmoji: {},
      });
      assert(pack && pack.id > 0, "бот: сборка пака с прогрессом");
      assert(calls.some((c) => c.method === "createNewStickerSet"), "бот: createNewStickerSet вызван");
      assert(calls.filter((c) => c.method === "editMessageText").length >= 2, "бот: прогресс редактировал сообщение");
      const doneText = calls.filter((c) => c.method === "editMessageText").pop().params.text;
      assert(doneText.includes("Пак готов") && doneText.includes("tg-emoji"), "бот: финал с кастомным эмодзи");
      assert(calls.some((c) => c.method === "sendSticker"), "бот: первый стикер пака прислан в чат");

      await bot.handleMainUpdate(cb(`pk:${pack.id}:rename`));
      assert(db.getPending(userId).action === "rename", "бот: rename ждёт текст");
      await bot.handleMainUpdate(msg("Новое имя"));
      assert(db.getPack(pack.id).title === "Новое имя", "бот: пак переименован");

      await bot.handleMainUpdate(cb(`pk:${pack.id}:add`));
      await bot.handleMainUpdate(msg("1"));
      assert(db.getPack(pack.id).included.length === 2, "бот: эмодзи добавлен по номеру");

      await bot.handleMainUpdate(cb(`pk:${pack.id}:remove`));
      await bot.handleMainUpdate(msg("2"));
      assert(db.getPack(pack.id).included.length === 1, "бот: эмодзи убран по позиции");

      await bot.handleMainUpdate(cb(`pk:${pack.id}:add`));
      await bot.handleMainUpdate(msg("3"));
      assert(db.getPack(pack.id).included.length === 1, "бот: повторное добавление без дублей");

      await bot.handleMainUpdate(cb(`pk:${pack.id}:delyes`));
      assert(db.listPacks(userId).length === 0, "бот: пак удалён");
      assert(calls.some((c) => c.method === "deleteStickerSet"), "бот: deleteStickerSet вызван");
    } finally {
      global.fetch = realFetch;
    }
  }

  // 1) Рендер настоящим replacer'ом.
  const render = require("./render");
  const buf = fs.readFileSync(path.join(ROOT, "emoji/master_tgs/003_f09f8ead.tgs"));
  const tgs = await render.renderTgs(buf, {
    kind: "text",
    text: "TEST",
    content_color: "#ff2d55",
    scale: 1,
    offset_x: 0,
    offset_y: 0,
    rotation: 0,
    font: "russo",
  });
  const buildMod = require("./build");
  const pn = buildMod.packName("123 тест", 42, "mainbot");
  assert(/^[a-z]/.test(pn) && pn.endsWith("_by_mainbot") && pn.length <= 64, "packName: буква в начале, суффикс цел: " + pn);

  const json = JSON.parse(zlib.gunzipSync(tgs).toString("utf8"));
  assert(json && Array.isArray(json.layers), "renderTgs выдаёт валидный Lottie");
  assert(tgs.length > 1000, `renderTgs размер ${tgs.length}`);

  // 2) HTTP API.
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), BOT_TOKEN: "", PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  try {
    await waitHealth();
    const base = `http://127.0.0.1:${PORT}`;

    const master = await (await fetch(base + "/api/master/list")).json();
    assert(Array.isArray(master) && master.length === 144, `master/list = ${master.length}`);
    const news = await (await fetch(base + "/api/new/list")).json();
    assert(Array.isArray(news) && news.length === 231, `new/list = ${news.length}`);
    assert(news[0].id.startsWith("new:") && news[0].preview, "new items: id new:N + preview");

    const tgsRes = await fetch(`${base}/api/master/${encodeURIComponent(master[2].file)}`);
    assert(tgsRes.ok && (await tgsRes.arrayBuffer()).byteLength > 1000, "master .tgs отдаётся");

    const fonts = await (await fetch(base + "/api/fonts/list")).json();
    assert(fonts.length === 6, "fonts/list = 6");
    const fontRes = await fetch(base + "/api/fonts/russo");
    assert(fontRes.ok && (await fontRes.arrayBuffer()).byteLength > 10000, "шрифт отдаётся");

    const pricing = await (await fetch(base + "/api/pricing")).json();
    assert(pricing.small_price_rub === 0 && pricing.full_price_rub === 0 && Array.isArray(pricing.passport_ids), "pricing: всё бесплатно");

    const png1x1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const prev = await fetch(base + "/api/png_preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: master[2].id, logo_png_b64: png1x1, scale: 1, offset_x: 0, offset_y: 0 }),
    });
    const prevData = await prev.json();
    assert(prev.ok && prevData.animation && prevData.animation.layers, "png_preview возвращает animation");

    const upListRes = await fetch(base + "/api/uploads/list");
    const upList = await upListRes.json();
    assert(upListRes.ok && Array.isArray(upList), "uploads/list отвечает (не перехвачен роутом файла)");
    const upStatus = await (await fetch(base + "/api/uploads/status")).json();
    assert(upStatus.status === "idle", "uploads/status отвечает");
    const bogusFont = await fetch(base + "/api/fonts/bogus");
    assert(bogusFont.status === 404, "неизвестный шрифт -> 404");

    const packs = await (await fetch(base + "/api/packs/list")).json();
    assert(Array.isArray(packs) && packs.length === 0, "packs/list пуст без паков");

    const home = await fetch(base + "/");
    assert(home.ok && (await home.text()).includes("app.js"), "index.html отдаётся");

    // Без бота сборка обязана честно ответить need_pack_bot.
    const buildRes = await fetch(base + "/api/build_pack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "emoji",
        global: { kind: "text", text: "TEST", font: "russo" },
        per_emoji: {},
        selected: [String(master[2].id)],
        pack_title: "Test",
      }),
    });
    const buildData = await buildRes.json();
    assert(buildRes.status === 403 && buildData.need_pack_bot === true, "build_pack без бота -> need_pack_bot");

    // Вебхук без настроенного бота не должен падать.
    const wh = await fetch(base + "/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 42 }, text: "/start" } }),
    });
    assert(wh.ok, "webhook отвечает 200");
  } finally {
    child.kill("SIGTERM");
  }
  // SQLite: файл создан, CRUD работает.
  const db = require("./db");
  db.open();
  assert(fs.existsSync(db.DB_FILE), "SQLite файл создан: " + db.DB_FILE);
  const pk = db.insertPack({ user_id: 999, title: "Selftest", short_name: "st_by_bot", link: "", format: "emoji", included: ["3"], global: {}, per_emoji: {}, bot_source: "main" });
  assert(pk.id > 0 && db.listPacks(999).length === 1, "SQLite packs insert/list");
  db.deletePack(pk.id);
  assert(db.listPacks(999).length === 0, "SQLite packs delete");

  // initData: свежесть подписи.
  {
    const crypto = require("crypto");
    const TOKEN = "999:stale-test-token";
    const sign = (params) => {
      const check = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
      const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
      return crypto.createHmac("sha256", secret).update(check).digest("hex");
    };
    const child2 = spawn(process.execPath, ["server/index.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT + 1), BOT_TOKEN: TOKEN, PUBLIC_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const base2 = `http://127.0.0.1:${PORT + 1}`;
      for (let i = 0; i < 40; i++) {
        try { const r = await fetch(base2 + "/healthz"); if (r.ok) break; } catch (_) {}
        await new Promise((r) => setTimeout(r, 250));
      }
      const mk = (authDate) => {
        const params = { auth_date: String(authDate), user: JSON.stringify({ id: 5, first_name: "T" }) };
        return new URLSearchParams({ ...params, hash: sign(params) }).toString();
      };
      const fresh = await fetch(base2 + "/api/packs/list", { headers: { "X-Telegram-Init-Data": mk(Math.floor(Date.now() / 1000)) } });
      assert(fresh.status === 200, "свежий initData принимается");
      const stale = await fetch(base2 + "/api/packs/list", { headers: { "X-Telegram-Init-Data": mk(1700000000) } });
      assert(stale.status === 401, "протухший initData отклоняется");
    } finally {
      child2.kill("SIGTERM");
    }
  }

  console.log("\nSELFTEST PASSED");
})().catch((e) => {
  console.error("\nSELFTEST FAILED:", e);
  process.exit(1);
});
