# Сервер и Telegram-бот (`server/src/`)

Запуск: `tsx src/index.ts` (без сборки). Пакет `@tge/server`, зависимости: express, socket.io, grammy, dotenv.

## index.ts — точка входа (≈370 строк)

| Строки | Что |
|---|---|
| 21-27 | `PORT`, `BOT_TOKEN`, `DEV_MODE`; предупреждение, если `DEV_MODE=1` вместе с публичным `WEBAPP_URL` |
| 29-37 | Express: `/health`, раздача `client/dist` + SPA-fallback на `index.html` |
| 39-40 | HTTP-сервер + Socket.IO (`cors: *`) |
| 47-54 | Middleware авторизации: `verifyInitData` → если нет и `DEV_MODE=1` → `devUser(devId)` |
| 63-67 | `viewOf(state, userId)` — запомнить увиденные постройки + `publicView` (маска тумана + скрытый seed) |
| 69-85 | `pushState`/`pushStateSafe` — рассылка всем сокетам комнаты (`state` или `update` с fx); `.catch` вместо `void`, чтобы ошибка не улетала в `unhandledRejection` |
| 91-101 | `safe(name, handler)` — оборачивает обработчик события: ack может быть не функцией, исключение не роняет процесс, а логируется и отвечает `{ok:false}` |
| 103-141 | Учёт присутствия в комнате: `offlineKey`, `offlineSince` (Map), `userHasOtherSocket`, `leaveRoom`, `enterRoom` |
| 144-278 | Обработчики событий сокета (см. протокол) |
| 280-333 | `sweep()` — уборщик лобби/партии, `setInterval(sweep, 10_000)` (см. ниже) |
| 335 | `process.on('unhandledRejection', ...)` |
| 337-360 | `listen(PORT, '0.0.0.0')`, обработка EADDRINUSE |
| 349-369 | `launchBot()` — запуск бота с повтором каждые `BOT_RETRY_MS` (15 с) при неудаче |

### Протокол Socket.IO

Клиент → сервер (все с ack-колбэком `{ok:true,state,fx?} | {ok:false,error}`, кроме `room:leave` — `{ok:true} | {ok:false,error}`).
Payload каждого действия сначала проходит `parseGameAction`/`parseLobbyAction` (`@tge/shared`, `shared/src/validate.ts`) —
любой мусор (не тот тип, отсутствующее поле, `unit:'constructor'` и т.п.) отклоняется без исключения:

| Событие | Payload | Обработчик | Делает |
|---|---|---|---|
| `room:create` | — | `:165` | `createRoom` + `joinState` |
| `room:solo` | — | `:172` | комната + `setupHotseat` (хост играет за двоих) |
| `room:join` | `{roomCode}` (строка ≤16 символов) | `:183` | `getRoom` + `joinState` (`addPlayer`, `enterRoom`) |
| `room:leave` | — | `:195` | `leaveRoom` (выходит из socket-room, при отсутствии других сокетов — `markDisconnected`) |
| `game:start` | — | `:212` | `startGame` (только хост) |
| `lobby:action` | `{action}` → `parseLobbyAction` | `:224` | `applyLobbyAction` |
| `game:action` | `{action}` → `parseGameAction` | `:238` | `applyAction` → `autoEndTurnIfExhausted` → ack автору, `update` остальным |
| `disconnect` | — | `:255` | Если не осталось других сокетов игрока в комнате — `markDisconnected` + запись в `offlineSince`; `pushState` |

Сервер → клиент: `me` (`{id,name}` при подключении), `state` (GameState), `update` (`{state, fx}`).

`joinState` (`:146`): запрещает чужим входить в hotseat-партию; `actingPlayerId` в hotseat подменяет
игрока на того, чей сейчас ход (кроме `squareReply` — там отвечает реальный юзер). Каждый вход комнаты
идёт через `enterRoom`, который сначала выходит из прежней комнаты сокета (`leaveRoom`), если она сменилась —
поэтому одна вкладка никогда не состоит в двух комнатах одновременно и не путает `pushState` между ними.

### sweep() — периодическая уборка (`setInterval`, каждые 10 с)

Работает по всем комнатам (`listRooms()` из `rooms.ts`, без обновления `updatedAt`):

- **Лобби** (`LOBBY_GRACE_MS = 90_000`): если игрок офлайн дольше этого времени — `removePlayer`
  (в лобби реально освобождает место и передаёт хоста). Перезагрузка страницы раньше этого срока
  ничего не отнимает — `enterRoom` снимает отметку офлайна при повторном входе.
- **Каре в идущей партии** (`SQUARE_REPLY_MS = 60_000`): если защитник офлайн или время вышло —
  сервер сам отвечает `squareReply {form:false}` за него, чтобы партия не зависла. Таймер
  (`squareSeenAt`) привязан к конкретному объекту `pendingSquare`, новое предложение — новый отсчёт.
  В hotseat-партиях уборщик не вмешивается вообще: «Соперник» всегда офлайн, отвечает сам хост.
- **Пропуск хода** (`TURN_SKIP_OFFLINE_MS = 180_000`, не применяется к hotseat-партиям): если
  текущий игрок офлайн дольше этого времени и в партии есть другой живой онлайн-игрок — сервер
  сам делает за него `endTurn`.

## bot.ts — Telegram-бот (grammY, long polling)

| Строки | Что |
|---|---|
| 10-19 | `HELP` — текст справки (HTML) |
| 26-27 | `inviteLink(code)` = `https://t.me/<bot>?start=<code>` |
| 29-30 | `isPrivate(ctx)` — кнопки `web_app` разрешены только в личных чатах |
| 32-44 | Клавиатуры: `playKeyboard`/`openKeyboard` — в личке WebApp-кнопки как раньше, в группе — URL-кнопки (`.url(...)`, ведут на `inviteLink`/профиль бота), т.к. `web_app`-кнопка в группе роняет `ctx.reply` |
| 46-65 | `/start [КОД]` — с кодом: проверка комнаты и кнопка; без — справка + «Играть» |
| 67-71 | `/play` — кнопка игры |
| 73 | `/help` |
| 75-88 | `/newgame` — `createRoom(tgUserId)`, код + приглашение |
| 90-104 | `/join КОД` — проверка комнаты, кнопка |
| 106-108 | `bot.catch` — лог ошибок |
| 110-119 | `setMyCommands` в своём `try/catch` — ошибка не отменяет запуск бота |
| 121-133 | Кнопка меню чата «Играть» (если URL https), тоже в `try/catch` |
| 135-137 | `bot.start(...).catch(...)` — отклонённый промис (например, 409 Conflict от второго запущенного экземпляра) не становится `unhandledRejection` |

Ссылки-приглашения: если задан `shortName` (`WEBAPP_SHORT_NAME`, Mini App создан в BotFather), `inviteLink`
даёт `t.me/<bot>/<shortName>?startapp=КОД` — игра открывается сразу, клиент берёт код из `start_param`.
Без `shortName` — `t.me/<bot>?start=КОД` через чат бота. Старые `/start КОД` продолжают работать.

## auth.ts

- `verifyInitData(initData, botToken)` `:16` — HMAC-SHA256 по алгоритму Telegram WebApp,
  срок жизни `auth_date` 7 дней (initData снимается один раз при открытии Mini App и не обновляется —
  сутки было слишком мало для переподключения после долгого разрыва связи), возвращает `{id, name}`.
- `devUser(rawId)` — пользователь `Тест-<id>` для `DEV_MODE`.

## rooms.ts

- `rooms: Map<code, {state, updatedAt}>` — только память процесса.
- `createRoom(hostId)` — уникальный 5-символьный код, `createGame(code, hostId, seed)`.
- `getRoom(code)` — возвращает state и продлевает `updatedAt`.
- `listRooms()` — все комнаты **без** обновления `updatedAt`; для уборщика (`sweep()` в `index.ts`),
  чтобы сам обход не продлевал жизнь комнате.
- `touchRoom`, `deleteRoom`, `summarize` — вспомогательные (сейчас почти не используются).
- `startRoomCleanup()` — раз в 5 мин удаляет: пустые (все `connected=false`) старше 30 мин, прочие — старше 6 ч без активности.

## Новое (план функций 2026-09-29)

- `storage.ts` — JSON на диске (`DATA_DIR`, по умолчанию `<root>/data`): `dataFile`, `writeJsonAtomic`, `readJsonSafe` (битый файл → `*.broken-<ts>.json`).
- `rooms.ts` — автосохранение `rooms.json` раз в 5 с (`markDirty`, `saveRooms`, `loadRooms`), SIGTERM/SIGINT сохраняют синхронно; TTL: лобби 6 ч / 30 мин без людей, партия 7 дней, законченная 24 ч; `myGames(userId)`.
- `turnClock.ts` — таймер хода (`state.turnDeadline`): `syncTurnClock`, `turnExpired`, `pauseTurnClock` (блиц не гонит пустую партию). `sweep()` сжигает ход по дедлайну; при `turnMinutes >= 60` офлайн-пропуск (3 мин) не действует.
- `users.ts` — реестр игроков (`data/users.json`): `canNotify`, `notify`, id последнего сообщения «ваш ход» по комнатам.
- `notify.ts` — очередь сообщений бота (~20/с): «Ваш ход», напоминание (0 → за 1 мин до офлайн-пропуска, 60 мин → за 15 мин, 24 ч → за 2 ч, блиц — нет), итоги партии, приглашение на реванш, предложение договора с кнопками. Без `BOT_TOKEN` — в консоль `[notify]`.
- `rematch.ts` — `rematchRoom`: новая комната с теми же настройками и ИИ, код в `state.rematchCode`.
- `aiRunner.ts` — ходы ИИ с паузой 500–700 мс (после мирного шага — 220 мс, чтобы разъезд всадников не тянул ход), каждое действие через `pushState` с fx; запускается из `pushState` и после загрузки с диска.
- `hub.ts` — мост `pushStateSafe` для модулей без доступа к `io`.
- Socket-события: `me` (`{id,name,canNotify}`), `room:mine`, `room:rematch`, `user:write`, `room:solo` с `{ai:[...], tutorial}`.
- Бот: `/games`, `/notify on|off`, callback `rematch:КОД`, `dip:a|d:КОД:ОТ`.
- Состояние приходит с `serverNow` (сверка обратного отсчёта).
