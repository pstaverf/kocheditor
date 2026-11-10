# kocheditor

Telegram Mini App — редактор кастомных эмодзи и стикеров: пользователь заменяет
«вшитый» текст `swex` в анимированных `.tgs` своим ником, логотипом или фото,
перекрашивает слои — и получает готовый пак, который создаёт бот.

Один Node.js-процесс (без внешних зависимостей, Node ≥ 18) на одном домене
обслуживает и WebApp, и вебхук бота, и JSON API.

## Запуск

```bash
cp .env.example .env   # заполнить BOT_TOKEN и PUBLIC_URL
BOT_TOKEN=123456:AAA... PUBLIC_URL=https://твой-домен node server/index.js
# или: npm start
```

При старте с `BOT_TOKEN` + `PUBLIC_URL` сервер сам ставит вебхук
`PUBLIC_URL/telegram/webhook`, кнопку меню WebApp и дальше работает без polling.

Для локальной проверки без Telegram: `node server/index.js` (dev-режим:
initData не проверяется, бот отключён). Проверка всего без сети: `npm test`.

За прокси (nginx/Caddy) домен должен терминировать HTTPS — Telegram не откроет
WebApp и не поставит вебхук на http.

## Как это устроено

| Путь | Что внутри |
|---|---|
| `index.html`, `app.js`, `style.css` | Фронт Mini App (vanilla JS) |
| `replacer.js` | Замена букв s/w/e/x в Lottie на текст/лого (opentype.js). Один и тот же код работает в браузере (превью) и на сервере (финальный рендер) |
| `server/index.js` | HTTP: статика `/static/*`, API `/api/*`, вебхуки `/telegram/webhook*` |
| `server/telegram.js` | Bot API клиент, валидация подписи initData (HMAC) |
| `server/render.js` | `replacer.js`+`opentype.min.js` в Node (vm): TGS → Lottie → правки → TGS |
| `server/catalog.js` | Сканирует `emoji/` (master: id-число, new: `new:N`), считает `logo_box` и `passport_ids` |
| `server/build.js` | Сборка пака: рендер тайлов → `uploadStickerFile` → `createNewStickerSet` |
| `server/bot.js` | Апдейты главного бота и персональных pack-ботов |
| `fonts/` | TTF шрифтов редактора (Seymour One, Rubik, Montserrat, Press Start 2P, Russo One, Pacifico; OFL) |
| `data/` | Runtime: `db.json` (юзеры, паки, токены pack-ботов) и `uploads/` (в .gitignore) |

## Боты

- **Главный бот** (`BOT_TOKEN`): `/start` выдаёт кнопку редактора, принимает
  загрузки (premium emoji / animated sticker / .tgs после кнопки «+» в редакторе),
  присылает ссылки на готовые паки. Вебхук: `POST /telegram/webhook`
  (при заданном `WEBHOOK_SECRET` проверяется заголовок секрета).
- **Персональный pack-бот юзера**: токен вводится в редакторе
  (`POST /api/pack_bot/save`), сервер ставит ему вебхук
  `/telegram/webhook/pack/<userId>` и ловит `/start` владельца — без него
  Telegram не даст боту создать пак на аккаунт владельца. Если свой бот не
  подключён, паки создаёт главный бот.

## API (то, что ждёт app.js)

Публичные: `GET /api/master/list`, `/api/new/list`, `/api/master|new/<file>`,
`/api/new_preview/<file>`, `/api/fonts/list|fallbacks|<key>`, `/api/pricing`.

С заголовком `X-Telegram-Init-Data`: `POST /api/build_pack`,
`POST /api/pack_bot/save|delete`, `GET /api/pack_bot/status`,
`POST /api/uploads/start|cancel`, `GET /api/uploads/status|list|<file>`,
`GET /api/packs/list`, `GET /api/packs/<id>`,
`POST /api/packs/<id>/rename|add_tiles|convert`, `POST /api/png_preview`.

## Известные ограничения

- Оплата из `pricing` только отображается во фронте; платёжный шлюз не подключён,
  сборка не гейтится оплатой.
- PNG-логотип в финальном паке кладётся image-слоем поверх бокса букв
  (в оригинальном проекте был покадровый композит с защитной маской).
- Экран «Иконки» — заглушка `icons.html`, отдельного редактора иконок в репозитории нет.
- Токены персональных ботов хранятся в `data/db.json` открытым текстом —
  файл должен быть недоступен снаружи (он вне статики и в .gitignore по папке `data/`).
