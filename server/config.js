"use strict";
// Конфигурация через переменные окружения (см. .env.example).
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function intEnv(name, def) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : def;
}

const botToken = process.env.BOT_TOKEN || "";

module.exports = {
  ROOT,
  port: intEnv("PORT", 3000),
  host: process.env.HOST || "0.0.0.0",
  // Публичный https-адрес, на котором живёт и WebApp, и вебхук, напр. https://example.com
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
  botToken,
  // Секрет для проверки заголовка X-Telegram-Bot-Api-Secret-Token у главного бота.
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  // Публичный бот, который пишется в подпись «by @…» (как в оригинальном фронте).
  publicPackBotUsername:
    (process.env.PUBLIC_PACK_BOT_USERNAME || "swexmakerbot").replace(/^@+/, ""),
  // Без BOT_TOKEN проверить подпись initData невозможно — для локальной
  // разработки разрешаем неподписанный initData (юзер берётся из initDataUnsafe).
  allowUnauth: process.env.ALLOW_UNAUTH === "1" || !botToken,
  dataDir: process.env.DATA_DIR || path.join(ROOT, "data"),
  pricing: {
    small_price_rub: intEnv("PRICE_SMALL_RUB", 55),
    mid_price_rub: intEnv("PRICE_MID_RUB", 100),
    full_price_rub: intEnv("PRICE_FULL_RUB", 250),
    passport_price_rub: intEnv("PRICE_PASSPORT_RUB", 25),
    conversion_price_rub: intEnv("PRICE_CONVERSION_RUB", 25),
    icon_pack_price_rub: intEnv("PRICE_ICON_PACK_RUB", 50),
    icon_addition_price_rub: intEnv("PRICE_ICON_ADDITION_RUB", 2),
    addition_price_rub: intEnv("PRICE_ADDITION_RUB", 2),
    small_threshold: intEnv("PRICE_SMALL_THRESHOLD", 10),
    mid_threshold: intEnv("PRICE_MID_THRESHOLD", 50),
    // passport_ids подставляет catalog.js при старте (тайлы с swex_text_* группами).
    passport_ids: [],
  },
};
