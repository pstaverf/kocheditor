"use strict";
// Дымовой тест без Telegram: поднимает сервер на случайном порту в dev-режиме
// и проверяет каталог, шрифты, цены, png_preview, рендер TGS и фолбэк build_pack.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

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
    assert(pricing.small_price_rub === 55 && Array.isArray(pricing.passport_ids), "pricing ок");

    const png1x1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const prev = await fetch(base + "/api/png_preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: master[2].id, logo_png_b64: png1x1, scale: 1, offset_x: 0, offset_y: 0 }),
    });
    const prevData = await prev.json();
    assert(prev.ok && prevData.animation && prevData.animation.layers, "png_preview возвращает animation");

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
  console.log("\nSELFTEST PASSED");
})().catch((e) => {
  console.error("\nSELFTEST FAILED:", e);
  process.exit(1);
});
