# Запуск, деплой, тесты

## Сервер (прод)

- Хост: `ssh peepuy` (root@31.58.244.209), каталог **`/root/tg-empires`** (не git-репозиторий — файлы копируются вручную).
- systemd-юнит **`tg-empires.service`**: `WorkingDirectory=/root/tg-empires`, `EnvironmentFile=.env`,
  `ExecStart=/usr/bin/npm start` (= `tsx server/src/index.ts`), `Restart=always`.
- nginx: `empires.31-58-244-209.sslip.io` (443, Certbot) → `proxy_pass http://127.0.0.1:3000`.
- Клиент на сервере — собранный `client/dist` (раздаёт Express).
- Рядом на том же сервере крутится другой проект (`peepuy`, `peepuy-miniapp` в nginx) — не трогать.

Обновление:
```bash
npm run build                      # локально или на сервере
# скопировать изменённые файлы в /root/tg-empires (+ client/dist)
systemctl restart tg-empires       # на сервере; ВСЕ партии в памяти пропадут
journalctl -u tg-empires -f        # логи
```

Сверка локального кода с сервером: md5 файлов (без `node_modules`, `dist`, `.env`) —
на 2026-09-27 совпадает с веткой `server-snapshot` (отличается только `.env`).

## Переменные окружения (`.env`, шаблон `.env.example`)

| Переменная | Назначение |
|---|---|
| `BOT_TOKEN` | токен бота; без него бот не стартует, а Telegram-вход не работает |
| `WEBAPP_URL` | публичный https-адрес Mini App (кнопки бота) |
| `WEBAPP_SHORT_NAME` | короткое имя Mini App из BotFather (`play`); ссылки-приглашения `t.me/<бот>/play?startapp=КОД`. Пусто — приглашения через `/start КОД` |
| `PORT` | порт сервера (3000) |
| `DEV_MODE` | `1` — вход без подписи Telegram (только локально!). `.env.example` теперь по умолчанию `0`; если `DEV_MODE=1` включён вместе с публичным (`https://`) `WEBAPP_URL`, сервер при старте пишет громкое предупреждение в лог |
| `VITE_SERVER_URL` | (клиент, опц.) адрес сервера, если не тот же origin |

`MAX_AUTH_AGE_SECONDS` (`server/src/auth.ts`) — срок жизни Telegram `initData`, теперь 7 дней (было 24 ч):
`initData` снимается один раз при открытии Mini App и не обновляется, суток не хватало для переподключения
после долгого разрыва связи.

## Локально

```bash
npm install
npm run dev          # сервер :3000 (tsx watch) + клиент :5173 (vite)
```
Два игрока в браузере: `http://localhost:5173/?dev=alice` и `?dev=bob&room=КОД`.

## Проверки

```bash
npm run smoke        # scripts/smoke.ts — ~30 сценариев правил без UI (assert)
npm run typecheck    # tsc по shared, server, client
npm run abuse        # scripts/abuse.ts — кривые payload'ы против локального сервера (нужен DEV_MODE=1)
```

Проверки smoke (`scripts/smoke.ts`): старт, валидация входящих действий (`validate.ts`), настройки лобби (включая
запрет включать/выключать `hotseat` через `configure`), hotseat, эпохи, каре (включая сброс ложного `square` после
уничтожения залпом), лимит действий и автоконец хода с учётом бесплатного продолжения похода, бой и падение державы,
неудачная атака, совместный удар, голод, ростер юнитов, ход свежего найма, лимиты движения, стройка, залп,
потери и командир, набег, слияние стеков, разделение смешанного стека, скрытие fx в лесу, обзор (включая
маскировку чужих ресурсов и `seed`), память построек, гекс-сетка, `markDisconnected`.

`scripts/abuse.ts` (npm run abuse): поднимите сервер отдельно (`DEV_MODE=1 npm run dev:server` или
`DEV_MODE=1 PORT=3000 npx tsx server/src/index.ts`), затем в другом терминале `npm run abuse` — скрипт шлёт
заведомо кривые `game:action`/`lobby:action` и проверяет, что `/health` после этого всё ещё отвечает `{ok:true}`.

## Прочее

- `openspec/` + `.cursor/` — заготовки OpenSpec/Cursor, спецификаций пока нет.
- Монорепо на npm workspaces: `shared`, `server`, `client`. TS-конфиг общий — `tsconfig.base.json`.
