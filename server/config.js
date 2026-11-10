"use strict";
// Конфигурация через переменные окружения (см. .env.example).
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Панели (Pterodactyl и т.п.) часто НЕ пробрасывают произвольные переменные
// в окружение процесса — поэтому дополнительно читаем .env из корня проекта.
// Настоящее окружение имеет приоритет и .env его не перебивает.
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) {
    // .env нет — работаем только на окружении процесса.
  }
})();

function intEnv(name, def) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : def;
}

const botToken = process.env.BOT_TOKEN || "";

module.exports = {
  ROOT,
  // Pterodactyl и подобные панели пробрасывают порт как SERVER_PORT.
  port: intEnv("PORT", intEnv("SERVER_PORT", 3000)),
  host: process.env.HOST || "0.0.0.0",
  // Публичный https-адрес, на котором живёт и WebApp, и вебхук, напр. https://example.com
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
  botToken,
  // Секрет для проверки заголовка X-Telegram-Bot-Api-Secret-Token у главного бота.
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  // ID админов через запятую (для /stats и /mailing). Пусто = команды закрыты.
  adminIds: (process.env.ADMIN_IDS || "")
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter(Number.isFinite),
  // Цена: 1 стикер/эмодзи = 1 Telegram Star.
  starPerSticker: 1,
  // Пауза между загрузками стикеров в Telegram (мс): с ней сборка чуть
  // дольше, зато не ловим "Too Many Requests: retry after …".
  stickerDelayMs: intEnv("STICKER_DELAY_MS", 300),
  // Публичный бот, который пишется в подпись «by @…» (как в оригинальном фронте).
  publicPackBotUsername:
    (process.env.PUBLIC_PACK_BOT_USERNAME || "swexmakerbot").replace(/^@+/, ""),
  // Без BOT_TOKEN проверить подпись initData невозможно — для локальной
  // разработки разрешаем неподписанный initData (юзер берётся из initDataUnsafe).
  allowUnauth: process.env.ALLOW_UNAUTH === "1" || !botToken,
  dataDir: process.env.DATA_DIR || path.join(ROOT, "data"),
  pricing: {
    small_price_rub: intEnv("PRICE_SMALL_RUB", 0),
    mid_price_rub: intEnv("PRICE_MID_RUB", 0),
    full_price_rub: intEnv("PRICE_FULL_RUB", 0),
    passport_price_rub: intEnv("PRICE_PASSPORT_RUB", 0),
    conversion_price_rub: intEnv("PRICE_CONVERSION_RUB", 0),
    icon_pack_price_rub: intEnv("PRICE_ICON_PACK_RUB", 0),
    icon_addition_price_rub: intEnv("PRICE_ICON_ADDITION_RUB", 0),
    addition_price_rub: intEnv("PRICE_ADDITION_RUB", 0),
    small_threshold: intEnv("PRICE_SMALL_THRESHOLD", 10),
    mid_threshold: intEnv("PRICE_MID_THRESHOLD", 50),
    // passport_ids подставляет catalog.js при старте (тайлы с swex_text_* группами).
    passport_ids: [],
  },
};
