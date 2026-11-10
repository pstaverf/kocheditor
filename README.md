# kocheditor

Telegram Mini App — редактор кастомных эмодзи и стикеров: пользователь заменяет
«вшитый» текст `swex` в анимированных `.tgs` своим ником, логотипом или фото,
перекрашивает слои — и получает готовый пак, который создаёт бот.

Один Node.js-процесс (без внешних зависимостей, Node ≥ 18) на одном домене
обслуживает и WebApp, и вебхук бота, и JSON API. Всё бесплатно — оплаты нет.
Данные хранятся в SQLite (`data/kocheditor.sqlite`, встроенный `node:sqlite`).

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

## Запуск на Pterodactyl

Нужен образ **Node.js 22 (минимум 22.5) или 24** — например `nodejs_22` /
`nodejs_24` (на Node < 22.5 нет `node:sqlite`, бэкенд не стартует).
Зависимостей у проекта нет, `NODE_PACKAGES` можно оставить пустым.

Startup Command:

```bash
if [[ -d .git ]] && [[ {{AUTO_UPDATE}} == "1" ]]; then git pull; fi; if [[ ! -z ${NODE_PACKAGES} ]]; then /usr/local/bin/npm install ${NODE_PACKAGES}; fi; if [[ ! -z ${UNNODE_PACKAGES} ]]; then /usr/local/bin/npm uninstall ${UNNODE_PACKAGES}; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; /usr/local/bin/node --disable-warning=ExperimentalWarning /home/container/server/index.js
```

Переменные окружения сервера: `BOT_TOKEN`, `PUBLIC_URL` (https-домен с
обратным прокси на порт сервера), `WEBHOOK_SECRET`. Если панель не
пробрасывает их в процесс, положите файл `.env` (см. `.env.example`) в корень
проекта — сервер читает его сам при старте; в логе появится строка
`[env] BOT_TOKEN=задан ...` для проверки. Порт берётся из `PORT`
или `SERVER_PORT` (его панель пробрасывает сама), `JS_FILE` не нужен —
точка входа захардкожена в команде как `server/index.js`.

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
| `server/bot.js` | Главный бот: сборка паков с прогрессом, управление паками, загрузки; вебхуки персональных pack-ботов |
| `server/db.js` | SQLite: pack-боты, паки, загрузки, ожидающие действия бота |
| `fonts/` | TTF шрифтов редактора (Seymour One, Rubik, Montserrat, Press Start 2P, Russo One, Pacifico; OFL) |
| `data/` | Runtime: `kocheditor.sqlite` и `uploads/` (в .gitignore) |

## Боты

- **Главный бот** (`BOT_TOKEN`): `/start` выдаёт кнопку редактора, принимает
  загрузки (premium emoji / animated sticker / .tgs после кнопки «+» в редакторе).
  Вебхук: `POST /telegram/webhook` (при заданном `WEBHOOK_SECRET` проверяется
  заголовок секрета).

  **Сборка и управление паками живут в боте.** В мини-аппе юзер жмёт «Создать
  пак» → аппка пишет «Перейдите к боту» и закрывается → бот присылает
  «Загружаю…» и редактирует сообщение по мере рендера/отправки (прогресс-бар),
  а в конце показывает карточку пака с кнопками:
  **открыть · переименовать · добавить эмодзи · убрать эмодзи · конвертировать ·
  удалить пак**. Добавление принимает номера тайлов из каталога
  (`12, 45, new:3`) или сам анимированный стикер/custom emoji сообщением;
  удаление эмодзи — по номерам позиций в паке. Команда `/packs` — список паков
  с теми же действиями. В текстах бота используются кастомные эмодзи
  (`<tg-emoji>` разметка, словарь `EMOJI_IDS` в `server/bot.js`).
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

- Оплаты нет вообще: `/api/pricing` отдаёт нули, фронт показывает «бесплатно».
- PNG-логотип в финальном паке кладётся image-слоем поверх бокса букв
  (в оригинальном проекте был покадровый композит с защитной маской).
- Экран «Иконки» — заглушка `icons.html`, отдельного редактора иконок в репозитории нет.
- Токены персональных ботов хранятся в SQLite открытым текстом — файл БД
  должен быть недоступен снаружи (папка `data/` вне статики и в .gitignore).
- `node:sqlite` — экспериментальный модуль Node 22 (в `npm start` предупреждение
  приглушено флагом); на Node < 22.5 бэкенд не запустится.
