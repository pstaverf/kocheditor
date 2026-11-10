"use strict";
// SQLite-хранилище (data/kocheditor.sqlite) на встроенном node:sqlite.
// Таблицы: персональные pack-боты, паки, сессии и предметы загрузок,
// ожидающие действия бота (переименование/добавление/удаление).
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

const DB_FILE = path.join(config.dataDir, "kocheditor.sqlite");
let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS pack_bots (
      user_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      bot_id INTEGER,
      bot_username TEXT,
      owner_user_id TEXT,
      webhook_secret TEXT,
      can_message_owner INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS packs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      short_name TEXT NOT NULL,
      link TEXT,
      format TEXT NOT NULL DEFAULT 'emoji',
      included TEXT NOT NULL DEFAULT '[]',
      global TEXT NOT NULL DEFAULT '{}',
      per_emoji TEXT NOT NULL DEFAULT '{}',
      bot_source TEXT NOT NULL DEFAULT 'main',
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_packs_user ON packs(user_id);
    CREATE TABLE IF NOT EXISTS upload_sessions (
      user_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'waiting',
      expires_at INTEGER NOT NULL DEFAULT 0,
      upload_id TEXT,
      error TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS upload_items (
      id TEXT PRIMARY KEY,
      file TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      v INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_upload_items_user ON upload_items(user_id);
    CREATE TABLE IF NOT EXISTS bot_pending (
      user_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      pack_id INTEGER,
      expires_at INTEGER NOT NULL DEFAULT 0,
      payload TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      first_name TEXT DEFAULT '',
      username TEXT DEFAULT '',
      balance_stars INTEGER NOT NULL DEFAULT 0,
      total_topup_stars INTEGER NOT NULL DEFAULT 0,
      packs_made INTEGER NOT NULL DEFAULT 0,
      stickers_made INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT,
      last_seen TEXT
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount_stars INTEGER NOT NULL,
      charge_id TEXT UNIQUE,
      payload TEXT DEFAULT '',
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Миграция для старых БД: payload у bot_pending.
  const cols = db.prepare("PRAGMA table_info(bot_pending)").all().map((c) => c.name);
  if (!cols.includes("payload")) db.exec("ALTER TABLE bot_pending ADD COLUMN payload TEXT DEFAULT ''");
  fixUploadIds();
  return db;
}

const json = (v, fallback) => {
  try {
    return JSON.parse(v);
  } catch (_) {
    return fallback;
  }
};

// ── Персональные pack-боты ───────────────────────────────────────────────────
function getPackBot(userId) {
  const row = open()
    .prepare("SELECT * FROM pack_bots WHERE user_id = ?")
    .get(String(userId));
  if (!row) return null;
  return { ...row, can_message_owner: !!row.can_message_owner };
}
function setPackBot(userId, rec) {
  open()
    .prepare(
      `INSERT INTO pack_bots (user_id, token, bot_id, bot_username, owner_user_id, webhook_secret, can_message_owner)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET token=excluded.token, bot_id=excluded.bot_id,
         bot_username=excluded.bot_username, owner_user_id=excluded.owner_user_id,
         webhook_secret=excluded.webhook_secret, can_message_owner=excluded.can_message_owner`
    )
    .run(
      String(userId),
      rec.token,
      rec.bot_id || null,
      rec.bot_username || "",
      String(rec.owner_user_id || userId),
      rec.webhook_secret || "",
      rec.can_message_owner ? 1 : 0
    );
}
function deletePackBot(userId) {
  open().prepare("DELETE FROM pack_bots WHERE user_id = ?").run(String(userId));
}
function setPackBotCanMessage(userId) {
  open()
    .prepare("UPDATE pack_bots SET can_message_owner = 1 WHERE user_id = ?")
    .run(String(userId));
}

// ── Паки ─────────────────────────────────────────────────────────────────────
function rowToPack(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    short_name: row.short_name,
    link: row.link,
    format: row.format,
    included: json(row.included, []),
    global: json(row.global, {}),
    per_emoji: json(row.per_emoji, {}),
    bot_source: row.bot_source,
    created_at: row.created_at,
  };
}
function insertPack(pack) {
  const info = open()
    .prepare(
      `INSERT INTO packs (user_id, title, short_name, link, format, included, global, per_emoji, bot_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Number(pack.user_id),
      pack.title,
      pack.short_name,
      pack.link || "",
      pack.format || "emoji",
      JSON.stringify(pack.included || []),
      JSON.stringify(pack.global || {}),
      JSON.stringify(pack.per_emoji || {}),
      pack.bot_source || "main",
      pack.created_at || new Date().toISOString()
    );
  pack.id = Number(info.lastInsertRowid);
  return pack;
}
function updatePack(pack) {
  open()
    .prepare(
      `UPDATE packs SET title=?, short_name=?, link=?, format=?, included=?, global=?, per_emoji=?, bot_source=?
       WHERE id=?`
    )
    .run(
      pack.title,
      pack.short_name,
      pack.link || "",
      pack.format || "emoji",
      JSON.stringify(pack.included || []),
      JSON.stringify(pack.global || {}),
      JSON.stringify(pack.per_emoji || {}),
      pack.bot_source || "main",
      pack.id
    );
}
function getPack(id) {
  return rowToPack(open().prepare("SELECT * FROM packs WHERE id = ?").get(Number(id)));
}
function getPackForUser(id, userId) {
  return rowToPack(
    open()
      .prepare("SELECT * FROM packs WHERE id = ? AND user_id = ?")
      .get(Number(id), Number(userId))
  );
}
function listPacks(userId) {
  return open()
    .prepare("SELECT * FROM packs WHERE user_id = ? ORDER BY id DESC")
    .all(Number(userId))
    .map(rowToPack);
}
function deletePack(id) {
  open().prepare("DELETE FROM packs WHERE id = ?").run(Number(id));
}

// ── Загрузки ─────────────────────────────────────────────────────────────────
function setUploadSession(userId, session) {
  open()
    .prepare(
      `INSERT INTO upload_sessions (user_id, status, expires_at, upload_id, error)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, expires_at=excluded.expires_at,
         upload_id=excluded.upload_id, error=excluded.error`
    )
    .run(
      String(userId),
      session.status || "waiting",
      session.expires_at || 0,
      session.upload_id || null,
      session.error || ""
    );
}
function getUploadSession(userId) {
  return (
    open().prepare("SELECT * FROM upload_sessions WHERE user_id = ?").get(String(userId)) || null
  );
}
function deleteUploadSession(userId) {
  open().prepare("DELETE FROM upload_sessions WHERE user_id = ?").run(String(userId));
}
function addUploadItem({ file, user_id }) {
  const info = open()
    .prepare("INSERT INTO upload_items (file, user_id, v) VALUES (?, ?, ?)")
    .run(file, Number(user_id), Math.floor(Date.now() / 1000));
  const n = Number(info.lastInsertRowid);
  const id = `upload:${n}`;
  // id завязан на rowid, чтобы фронт и каталог ссылались на стабильный upload:N.
  open()
    .prepare("UPDATE upload_items SET id = ? WHERE rowid = ?")
    .run(id, n);
  return { id, file, user_id: Number(user_id), v: Math.floor(Date.now() / 1000) };
}
function getUploadItem(id) {
  return open().prepare("SELECT * FROM upload_items WHERE id = ?").get(String(id)) || null;
}
function listUploadItems(userId) {
  return open()
    .prepare("SELECT * FROM upload_items WHERE user_id = ? ORDER BY rowid")
    .all(Number(userId));
}
function findUploadItem(userId, file) {
  return (
    open()
      .prepare("SELECT * FROM upload_items WHERE user_id = ? AND file = ?")
      .get(Number(userId), file) || null
  );
}

function fixUploadIds() {
  open()
    .prepare("UPDATE upload_items SET id = 'upload:' || rowid WHERE id IS NULL OR id = ''")
    .run();
}
function deleteUploadItem(id) {
  open().prepare("DELETE FROM upload_items WHERE id = ?").run(String(id));
}

// ── Ожидающие действия бота (rename/add/remove для конкретного пака) ─────────
function setPending(userId, action, packId, ttlMs = 10 * 60 * 1000, payload = "") {
  open()
    .prepare(
      `INSERT INTO bot_pending (user_id, action, pack_id, expires_at, payload) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET action=excluded.action, pack_id=excluded.pack_id, expires_at=excluded.expires_at, payload=excluded.payload`
    )
    .run(String(userId), action, packId ? Number(packId) : null, Date.now() + ttlMs, String(payload || ""));
}
function getPending(userId) {
  const row = open()
    .prepare("SELECT * FROM bot_pending WHERE user_id = ?")
    .get(String(userId));
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) {
    clearPending(userId);
    return null;
  }
  return row;
}
function clearPending(userId) {
  open().prepare("DELETE FROM bot_pending WHERE user_id = ?").run(String(userId));
}

// ── Пользователи и баланс (Telegram Stars) ───────────────────────────────────
function touchUser(u) {
  if (!u || u.id == null) return;
  const now = new Date().toISOString();
  open()
    .prepare(
      `INSERT INTO users (id, first_name, username, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         first_name = CASE WHEN excluded.first_name != '' THEN excluded.first_name ELSE users.first_name END,
         username = CASE WHEN excluded.username != '' THEN excluded.username ELSE users.username END,
         last_seen = excluded.last_seen`
    )
    .run(Number(u.id), u.first_name || "", u.username || "", now, now);
}
function getUser(id) {
  return open().prepare("SELECT * FROM users WHERE id = ?").get(Number(id)) || null;
}
function getBalance(id) {
  const u = getUser(id);
  return u ? u.balance_stars : 0;
}
function creditStars(id, amount, chargeId, payload) {
  // Допускаем объектную форму: creditStars(id, amount, { chargeId, payload })
  if (chargeId && typeof chargeId === "object") {
    payload = chargeId.payload;
    chargeId = chargeId.chargeId;
  }
  amount = Math.floor(Number(amount) || 0);
  if (amount <= 0) return false;
  touchUser({ id });
  const d = open();
  if (chargeId) {
    // Идемпотентность: один и тот же successful_payment не кредитуем дважды.
    const info = d
      .prepare("INSERT OR IGNORE INTO payments (user_id, amount_stars, charge_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(Number(id), amount, chargeId, payload || "", new Date().toISOString());
    if (!info.changes) return false;
  } else {
    d.prepare("INSERT INTO payments (user_id, amount_stars, charge_id, payload, created_at) VALUES (?, ?, NULL, ?, ?)")
      .run(Number(id), amount, payload || "", new Date().toISOString());
  }
  d.prepare("UPDATE users SET balance_stars = balance_stars + ?, total_topup_stars = total_topup_stars + ? WHERE id = ?")
    .run(amount, amount, Number(id));
  return true;
}
function debitStars(id, amount) {
  if (amount <= 0) return true;
  const info = open()
    .prepare("UPDATE users SET balance_stars = balance_stars - ? WHERE id = ? AND balance_stars >= ?")
    .run(amount, Number(id), amount);
  return !!info.changes;
}
function bumpUserMade(id, packs, stickers) {
  touchUser({ id });
  open()
    .prepare("UPDATE users SET packs_made = packs_made + ?, stickers_made = stickers_made + ? WHERE id = ?")
    .run(packs || 0, stickers || 0, Number(id));
}
function usersCount() {
  return open().prepare("SELECT COUNT(*) AS n FROM users").get().n;
}
function listUserIds() {
  return open().prepare("SELECT id FROM users ORDER BY id").all().map((r) => r.id);
}
function totalTopupStars() {
  return open().prepare("SELECT COALESCE(SUM(amount_stars), 0) AS n FROM payments").get().n;
}
function statsInc(key, by = 1) {
  open()
    .prepare("INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value")
    .run(key, by);
}
function statsGet(key) {
  const row = open().prepare("SELECT value FROM stats WHERE key = ?").get(key);
  return row ? row.value : 0;
}

module.exports = {
  open,
  DB_FILE,
  getPackBot,
  setPackBot,
  deletePackBot,
  setPackBotCanMessage,
  insertPack,
  updatePack,
  getPack,
  getPackForUser,
  listPacks,
  deletePack,
  setUploadSession,
  getUploadSession,
  deleteUploadSession,
  addUploadItem,
  getUploadItem,
  listUploadItems,
  findUploadItem,
  fixUploadIds,
  deleteUploadItem,
  setPending,
  getPending,
  clearPending,
  touchUser,
  getUser,
  getBalance,
  creditStars,
  debitStars,
  bumpUserMade,
  usersCount,
  listUserIds,
  totalTopupStars,
  statsInc,
  statsGet,
};
