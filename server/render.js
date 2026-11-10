"use strict";
// Серверный рендер TGS: тот же replacer.js, что рисует превью в браузере,
// запускается в Node через vm (opentype.min.js умеет require()).
// Никакого второго «питонного» рендерера — превью и финальный пак не разойдутся.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");
const config = require("./config");

const FONTS = [
  { key: "seymour", label: "Seymour One", sample: "Lean", file: "seymour.ttf" },
  { key: "rubik", label: "Rubik", sample: "Lean", file: "rubik.ttf" },
  { key: "montserrat", label: "Montserrat", sample: "Lean", file: "montserrat.ttf" },
  { key: "press", label: "Press Start 2P", sample: "Lean", file: "press.ttf" },
  { key: "russo", label: "Russo One", sample: "Lean", file: "russo.ttf" },
  { key: "pacifico", label: "Pacifico", sample: "Lean", file: "pacifico.ttf" },
];
const DEFAULT_FONT_KEY = "seymour";

let replacer = null;
function getReplacer() {
  if (replacer) return replacer;
  const opentype = require(path.join(config.ROOT, "opentype.min.js"));
  const sandbox = { window: {}, opentype, console, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(config.ROOT, "replacer.js"), "utf8"), sandbox, {
    filename: "replacer.js",
  });
  replacer = sandbox.window.SwexReplacer;
  if (!replacer) throw new Error("SwexReplacer not initialised");
  return replacer;
}

function fontByKey(key) {
  return FONTS.find((f) => f.key === key) || FONTS[0];
}
function fontPath(key) {
  return path.join(config.ROOT, "fonts", fontByKey(key).file);
}

// replacer хранит загруженные шрифты в модульном состоянии — сериализуем рендеры.
let renderChain = Promise.resolve();
function serialized(fn) {
  const run = renderChain.then(fn, fn);
  renderChain = run.catch(() => {});
  return run;
}

async function ensureFont(fontKey) {
  const R = getReplacer();
  const fallback = fontPath("russo");
  const main = fontPath(fontKey);
  await R.loadFont(main, main === fallback ? [] : [fallback]);
}

const gunzipJson = (buf) => JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
const gzipJson = (json) => zlib.gzipSync(JSON.stringify(json), { level: 9 });

function findTextGroups(json) {
  const names = [];
  (function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (node.ty === "gr" && typeof node.nm === "string" && node.nm.startsWith("swex_text_")) {
      names.push(node.nm);
    }
    for (const k of ["layers", "assets", "shapes", "it"]) {
      if (Array.isArray(node[k])) node[k].forEach(visit);
    }
  })(json);
  return names;
}

// Статичный бокс букв swex в canvas-координатах (аналог серверного logo_box у фронта).
function staticSwexBox(json) {
  try {
    const R = getReplacer();
    const containers = R.findSwexContainers(json);
    if (!containers || !containers.length) return null;
    const [lx0, ly0, lx1, ly1] = containers[0].bbox;
    const xform = R.swexCanvasXformAtFrame(json, 0);
    if (!xform) return [lx0, ly0, lx1, ly1];
    const [sx, sy, ox, oy] = xform;
    const xs = [ox + sx * lx0, ox + sx * lx1];
    const ys = [oy + sy * ly0, oy + sy * ly1];
    return [
      Math.round(Math.min(...xs) * 10) / 10,
      Math.round(Math.min(...ys) * 10) / 10,
      Math.round(Math.max(...xs) * 10) / 10,
      Math.round(Math.max(...ys) * 10) / 10,
    ];
  } catch (_) {
    return null;
  }
}

function passportLines(json) {
  const groups = findTextGroups(json);
  if (!groups.length) return null;
  const R = getReplacer();
  let hasContainer = false;
  try {
    hasContainer = (R.findSwexContainers(json) || []).length > 0;
  } catch (_) {}
  const lines = [];
  if (hasContainer) lines.push({ name: "__header__", text: "SWEX" });
  for (const nm of groups) lines.push({ name: nm, text: nm.replace(/^swex_text_/, "") });
  return lines;
}

// ── PNG-логотип: replacer умеет только вектор; для растра кладём image-layer
// поверх canvas-бокса букв (в превью фронт делает так же, только HTML-оверлеем).
function pngSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 10 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) break;
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return { w: 512, h: 512 };
}

function insertPngLayer(json, pngB64, box) {
  if (!box) return json;
  let buf;
  try {
    buf = Buffer.from(pngB64, "base64");
  } catch (_) {
    return json;
  }
  const { w, h } = pngSize(buf);
  const [x0, y0, x1, y1] = box;
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);
  const scale = Math.min(bw / w, bh / h) * 100;
  const assetId = "swex_png_logo";
  json.assets = Array.isArray(json.assets) ? json.assets : [];
  json.assets.push({
    id: assetId,
    w,
    h,
    p: "data:image/png;base64," + pngB64,
    e: 1,
  });
  json.layers = Array.isArray(json.layers) ? json.layers : [];
  const maxInd = json.layers.reduce((m, l) => Math.max(m, +(l && l.ind) || 0), 0);
  json.layers.unshift({
    ddd: 0,
    ind: maxInd + 1,
    ty: 2,
    nm: "swex_png_logo",
    refId: assetId,
    sr: 1,
    ks: {
      o: { a: 0, k: 100 },
      r: { a: 0, k: 0 },
      p: { a: 0, k: [(x0 + x1) / 2, (y0 + y1) / 2, 0] },
      a: { a: 0, k: [w / 2, h / 2, 0] },
      s: { a: 0, k: [scale, scale, 100] },
    },
    ao: 0,
    ip: 0,
    op: Number(json.op) || 90,
    st: 0,
    bm: 0,
  });
  return json;
}

// Применить override к Lottie JSON (мутирует копию внутри replacer.applyToLottie).
async function applyOverride(lottieJson, override) {
  return serialized(async () => {
    await ensureFont((override && override.font) || DEFAULT_FONT_KEY);
    const R = getReplacer();
    const box = override && override.kind === "logo" && override.logo_png_b64
      ? staticSwexBox(lottieJson)
      : null;
    const out = R.applyToLottie(lottieJson, override || {});
    if (box && override.logo_png_b64) insertPngLayer(out, override.logo_png_b64, box);
    return out;
  });
}

async function renderTgs(tgsBuffer, override) {
  const json = gunzipJson(tgsBuffer);
  const out = await applyOverride(json, override);
  return gzipJson(out);
}

module.exports = {
  FONTS,
  DEFAULT_FONT_KEY,
  fontByKey,
  fontPath,
  getReplacer,
  gunzipJson,
  gzipJson,
  staticSwexBox,
  passportLines,
  applyOverride,
  renderTgs,
};
