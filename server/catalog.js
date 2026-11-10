"use strict";
// Каталог тайлов: emoji/master_tgs (id = число), emoji/new_tgs (id = "new:N"),
// загрузки юзеров из db (id = "upload:N"). Порядок — по имени файла.
const fs = require("fs");
const path = require("path");
const config = require("./config");
const db = require("./db");
const render = require("./render");

const MASTER_DIR = path.join(config.ROOT, "emoji", "master_tgs");
const NEW_DIR = path.join(config.ROOT, "emoji", "new_tgs");
const NEW_PREVIEW_DIR = path.join(config.ROOT, "emoji", "new_png");
const UPLOAD_DIR = path.join(config.dataDir, "uploads");

let masters = [];
let news = [];
const metaCache = new Map(); // abs path -> { logo_box, passport_lines }

function listDir(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".tgs"))
      .sort();
  } catch (_) {
    return [];
  }
}

function scan() {
  masters = listDir(MASTER_DIR).map((file, i) => {
    const prefix = parseInt(file, 10);
    return {
      // id — номер из префикса файла (001_...), чтобы не съезжал при дырках.
      id: Number.isFinite(prefix) && prefix > 0 ? prefix : i + 1,
      file,
      v: Math.floor(fs.statSync(path.join(MASTER_DIR, file)).mtimeMs / 1000),
    };
  });
  news = listDir(NEW_DIR).map((file, i) => {
    const preview = file.replace(/\.tgs$/i, ".png");
    const entry = {
      id: `new:${i + 1}`,
      file,
      v: Math.floor(fs.statSync(path.join(NEW_DIR, file)).mtimeMs / 1000),
    };
    const previewPath = path.join(NEW_PREVIEW_DIR, preview);
    if (fs.existsSync(previewPath)) {
      entry.preview = preview;
      entry.preview_v = Math.floor(fs.statSync(previewPath).mtimeMs / 1000);
    }
    return entry;
  });
}

// logo_box и passport_lines считаются из самих .tgs — дорого на каждый запрос,
// поэтому один раз в фоне после старта и дальше отдаём из кэша.
function computeMeta() {
  const all = [
    ...masters.map((f) => path.join(MASTER_DIR, f.file)),
    ...news.map((f) => path.join(NEW_DIR, f.file)),
  ];
  for (const p of all) {
    try {
      const json = render.gunzipJson(fs.readFileSync(p));
      metaCache.set(p, {
        logo_box: render.staticSwexBox(json),
        passport_lines: render.passportLines(json),
      });
    } catch (e) {
      console.warn("[catalog] meta failed for", p, e.message);
    }
  }
  config.pricing.passport_ids = allFiles()
    .filter((f) => {
      const m = metaCache.get(resolvePath(f.id));
      return m && m.passport_lines;
    })
    .map((f) => f.id);
  console.log(
    `[catalog] ${masters.length} master + ${news.length} new, паспортов: ${config.pricing.passport_ids.length}`
  );
}

function withMeta(entry, absPath) {
  const m = metaCache.get(absPath);
  if (!m) return { ...entry };
  const out = { ...entry };
  if (m.logo_box) out.logo_box = m.logo_box;
  if (m.passport_lines) out.passport_lines = m.passport_lines;
  return out;
}

function masterList() {
  return masters.map((f) => withMeta(f, path.join(MASTER_DIR, f.file)));
}
function newList() {
  return news.map((f) => withMeta(f, path.join(NEW_DIR, f.file)));
}

function uploadList(userId) {
  return db
    .listUploadItems(userId)
    .map((u) => ({ id: u.id, file: u.file, v: u.v }));
}

function allFiles() {
  return [...masters, ...news];
}

function resolvePath(id) {
  if (typeof id === "string" && id.startsWith("upload:")) {
    const item = db.getUploadItem(id);
    return item ? path.join(UPLOAD_DIR, item.file) : null;
  }
  if (typeof id === "string" && id.startsWith("new:")) {
    const f = news.find((x) => x.id === id);
    return f ? path.join(NEW_DIR, f.file) : null;
  }
  const f = masters.find((x) => x.id === Number(id));
  return f ? path.join(MASTER_DIR, f.file) : null;
}

function readTile(id) {
  const p = resolvePath(id);
  if (!p || !fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

function isNewId(id) {
  return typeof id === "string" && id.startsWith("new:");
}

module.exports = {
  MASTER_DIR,
  NEW_DIR,
  NEW_PREVIEW_DIR,
  UPLOAD_DIR,
  scan,
  computeMeta,
  masterList,
  newList,
  uploadList,
  allFiles,
  resolvePath,
  readTile,
  isNewId,
};
