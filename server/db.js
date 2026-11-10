"use strict";
// Крошечное JSON-хранилище (data/db.json). Объёмы проекта (юзеры, паки,
// загрузки) не требуют настоящей БД; запись атомарная через tmp+rename.
const fs = require("fs");
const path = require("path");
const config = require("./config");

const DB_FILE = path.join(config.dataDir, "db.json");

const empty = () => ({
  packBots: {}, // userId -> { token, bot_id, bot_username, owner_user_id, webhook_secret, can_message_owner }
  packs: [], // { id, user_id, title, short_name, link, format, included[], global, per_emoji{}, bot_source, created_at }
  uploadSessions: {}, // userId -> { status, expires_at, upload_id, error }
  uploadItems: {}, // "upload:N" -> { id, file, user_id, v }
  seq: { pack: 1, upload: 1 },
});

let state = empty();

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    state = Object.assign(empty(), JSON.parse(raw));
  } catch (_) {
    state = empty();
  }
  return state;
}

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

function nextId(kind) {
  state.seq[kind] = (state.seq[kind] || 1) + 1;
  return state.seq[kind] - 1;
}

module.exports = {
  load,
  save,
  nextId,
  get state() {
    return state;
  },
};
