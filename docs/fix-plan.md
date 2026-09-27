# План исправления ошибок (для исполнителя-агента)

> Документ — пошаговое ТЗ. Выполняй этапы строго по порядку, после каждого этапа запускай проверки.
> Номера строк — на ветку `server-snapshot` (2026-09-27). Если строки сдвинулись — ищи по имени функции.

## 0. Правила работы

1. Сначала прочитай `CLAUDE.md` и `docs/MAP.md`. Читай только нужные участки файлов.
2. Правила игры меняются только в `shared/`. Сервер (`server/`) остаётся generic.
3. **Не меняй баланс** (цифры в `config.ts`, `units.ts`, `eras.ts`, формулы боя) — в плане нет ни одной правки баланса.
4. После каждого этапа:
   ```bash
   npm run typecheck
   npm run smoke
   ```
   Оба должны пройти. Новые проверки добавляй в `scripts/smoke.ts` функцией `checkXxx()` и вызовом в конце файла (список вызовов сейчас `:1760-1782`).
5. **Не коммить, не деплой на прод** (`ssh peepuy`) и не трогай `.env` на сервере без явной просьбы пользователя.
6. Этапы, помеченные **«спросить пользователя»**, не делай, пока пользователь не ответит.
7. В конце обнови `docs/MAP.md`, `docs/server.md`, `docs/client.md`, `docs/deploy.md` (номера строк, новое событие `room:leave`, новые константы).
8. Стиль кода — как в окружающем коде: TypeScript, ESM-импорты с `.js` в `shared/` и `server/`, комментарии по-русски, коротко.

---

## Этап 1. Сервер не должен падать от кривого сообщения (КРИТИЧНО)

**Проблема.** Обработчики `socket.on(...)` в `server/src/index.ts:94-161` передают payload в движок без проверки. Например, `game:action {action:{type:'build'}}` (нет `at`) → `action.at.x` бросает `TypeError`. socket.io вызывает обработчики внутри `process.nextTick`, поэтому исключение становится `uncaughtException` → процесс падает → systemd перезапускает → **все партии в памяти теряются**. То же для `unit/building/commander = "constructor"` (находится в прототипе объекта, `info.cost` → `undefined` → падение в `canAfford`).

### 1.1. Новый файл `shared/src/validate.ts`

Экспортировать две функции. Они принимают `unknown` и возвращают либо чистый объект нужного типа, либо `null`. Никаких исключений.

```ts
export function parseGameAction(raw: unknown): GameAction | null
export function parseLobbyAction(raw: unknown): LobbyAction | null
```

Правила проверки (типы — `shared/src/types.ts:140-156`):

| Поле | Проверка |
|---|---|
| `raw` | не `null`, `typeof === 'object'`, не массив |
| `type` | строго одно из значений union-типа |
| `Coord` (`at`, `from`, `to`) | объект, `Number.isInteger(x) && Number.isInteger(y)`, `0 <= x,y < 64` |
| `count` | `Number.isInteger(count) && count >= 1 && count <= 10000` |
| `unit` (опц.) | `undefined` или входит в `UNIT_IDS` (экспорт из `units.ts`) |
| `building` | одно из `'farm','mine','market','palisade','fort','barracks'` |
| `commander` | одно из `'warlord','marshal','scout'` |
| `tech` | одно из `'attack','defense','economy','logistics'` |
| `terrain` | одно из `'plains','forest','hills','mountains','water'` |
| `supportFrom` (опц.) | массив длиной ≤ 6, каждый элемент — корректный `Coord` |
| `form`, `admin` | `typeof === 'boolean'` |
| `playerId` | непустая строка длиной ≤ 128 |
| `settings` (configure) | обычный объект (не массив, не null). Внутри значения не проверяй — это делает `sanitizeSettings` |

Списки значений задай константами-массивами `as const` в `validate.ts` (или переиспользуй существующие, если они экспортируются). Для проверки принадлежности используй `array.includes(v)`. **Не используй `v in obj` и `obj[v]` на словарях** — именно так пролезает `constructor`.

Возвращай **новый** объект только с известными полями, лишние выбрасывай.

Реэкспортируй из `shared/src/index.ts`.

### 1.2. Защита в самом движке (второй рубеж)

В `shared/src/engine.ts` замени поиск по словарю через прототип на проверку «собственного» ключа:

- `:1033-1055` `recruit`: `action.unit && units[action.unit]` → `action.unit && Object.hasOwn(units, action.unit)`
- `:1102` `move`: `action.unit && UNITS[action.unit]` → `Object.hasOwn(UNITS, action.unit)`
- `:1019` `build`: `const info = buildingsOf(state)[action.building]; if (!info)` → сначала `if (!Object.hasOwn(buildingsOf(state), action.building)) return { ok:false, error:'Неизвестная постройка' }`
- `:1068` `appoint`: то же для `commandersOf(state)`
- `:999` `research`: то же для `techsFor(era(state))`

(`target: ES2022` в `tsconfig.base.json`, так что `Object.hasOwn` доступен.)

### 1.3. Обёртка обработчиков в `server/src/index.ts`

Добавь helper и заверни в него **все** `socket.on(...)` внутри `io.on('connection')`:

```ts
/** Ошибка в одном событии не должна ронять сервер со всеми партиями. */
function safe<P>(name: string, handler: (payload: P, reply: Ack) => void | Promise<void>) {
  return async (payload: P, ack?: unknown) => {
    const reply: Ack = typeof ack === 'function' ? (ack as Ack) : () => {};
    try {
      await handler(payload, reply);
    } catch (err) {
      console.error(`[socket] ${name}:`, err);
      reply({ ok: false, error: 'Внутренняя ошибка сервера' });
    }
  };
}
```

Важно: `ack` от клиента может оказаться не функцией (клиент вправе прислать что угодно) — поэтому `typeof ack === 'function'`.

В `game:action` и `lobby:action` сразу после получения payload:

```ts
const action = parseGameAction(payload?.action);
if (!action) return reply({ ok: false, error: 'Некорректное действие' });
```

`room:join`: `roomCode` должен быть строкой длиной ≤ 16, иначе ошибка «Комната не найдена».

### 1.4. Глобальная страховка

В `server/src/index.ts` в конце:

```ts
process.on('unhandledRejection', (err) => console.error('[server] unhandledRejection:', err));
```

Все вызовы `void pushState(...)` замени на `pushState(...).catch((err) => console.error('[server] pushState:', err))` (или сделай это внутри `pushState` через try/catch).

### 1.5. Проверки

- `smoke.ts`: `checkValidateActions()` — `parseGameAction` возвращает `null` для: `null`, `{}`, `{type:'build'}`, `{type:'build', at:{x:1,y:1}, building:'constructor'}`, `{type:'recruit', at:{x:0,y:0}, count:NaN}`, `{type:'move', from:{x:'a',y:0}, to:{x:1,y:1}, count:1}`, `{type:'hack'}`. И возвращает объект для корректного `move`/`endTurn`/`squareReply`. То же для `parseLobbyAction` (`paint` без `at`, `configure` без `settings`, `setAdmin` с `admin:'yes'`).
- `smoke.ts`: вызов `applyAction(state, id, {type:'recruit', at, count:1, unit:'constructor' as any})` не бросает исключение и возвращает `ok` (найм юнита по умолчанию) или `ok:false` — главное, без throw.
- Ручная проверка (опционально): скрипт `scripts/abuse.ts` на `socket.io-client` против локального сервера с `DEV_MODE=1` шлёт кривые события из списка выше и в конце проверяет, что `GET /health` отвечает `{ok:true}`. Если сделаешь — добавь `"abuse": "tsx scripts/abuse.ts"` в корневой `package.json`.

---

## Этап 2. Нельзя переключать «сам с собой» через настройки лобби (КРИТИЧНО)

**Проблема.** `sanitizeSettings` (`engine.ts:297`) пропускает `hotseat`. Админ лобби шлёт `configure {hotseat:true}` → после старта хост ходит за всех. `hotseat:false` в соло-партии → ход «Соперника» никто не может сделать.

**Исправление.** Удалить строку
```ts
if (typeof patch.hotseat === 'boolean') next.hotseat = patch.hotseat;
```
из `sanitizeSettings`. `hotseat` выставляет только `setupHotseat` (`engine.ts:179`). Клиент `hotseat` через `configure` не шлёт (проверено) — UI не сломается.

**Проверка** (`smoke.ts`, в `checkLobbySettings` или новая функция): обычная комната + `applyLobbyAction(state, host, {type:'configure', settings:{hotseat:true}})` → `state.settings.hotseat` остаётся `false`. Соло (`setupHotseat`) + `configure {hotseat:false}` → остаётся `true`.

---

## Этап 3. Не отдавать клиенту секреты (КРИТИЧНО)

**Проблема.** `state.seed` уходит клиенту как есть. Все броски боя и бегства (`nextRandom`, `engine.ts:633`) детерминированно выводятся из seed, причём seed известен уже в лобби. Модифицированный клиент заранее знает исход любого боя.

### 3.1. Seed
В `server/src/index.ts` `viewOf` (`:51-55`):

```ts
function viewOf(state: GameState, userId: string): GameState {
  const viewer = actingPlayerId(state, userId);
  rememberSeenBuildings(state, viewer);
  const view = maskStateFor(state, viewer);
  // Seed определяет все будущие броски боя — клиенту его знать нельзя.
  return state.phase === 'finished' ? view : { ...view, seed: 0 };
}
```

Клиент `state.seed` не использует (проверено grep'ом). Прогноз боя в UI (`battleForecastRatio`) seed не использует.

### 3.2. Ресурсы соперников при тумане войны
В `shared/src/vision.ts` `maskStateFor` (`:140`) для чужих игроков дополнительно обнулять ресурсы:
```ts
player.id === viewerId ? player : { ...player, seenBuildings: {}, resources: { gold: 0, food: 0, iron: 0 } }
```
`tech` чужих игроков **не трогать** — его использует прогноз боя (`defenseMultiplier` берёт `defender.tech.defense`). Клиент читает только `me.resources` (проверено).

### 3.3. Журнал (`state.log`) — НЕ делать в этом плане
Записи журнала — свободный текст, их не замаскировать без переделки в структурные события. Просто упомяни это в итоговом отчёте как известное ограничение.

**Проверка** (`smoke.ts`, в `checkVision` или новая): `maskStateFor` для игрока A при `fogOfWar: true` возвращает у игрока B `resources` = нули, а у A — реальные. Проверку seed сделай, вынеся логику из 3.1 в чистую функцию `shared/src/vision.ts: publicView(state, viewerId)` (и вызывай её из `viewOf`), тогда её можно проверить в smoke. Вариант на выбор исполнителя, главное — есть тест.

---

## Этап 4. Мелкий баг правил: каре на пустой клетке после залпа

**Проблема.** `engine.ts` `case 'shoot'`, ветка `losses >= defCount` (~`:1410`): отряд уничтожен, но `to.square` остаётся `true` → в начале следующего хода владельца лишняя запись «каре рассыпалось».

**Исправление.** В этой ветке заменить
```ts
writeWings(to, []);
to.commander = null;
to.routedTurns = 0;
```
на `clearMarch(to);` (функция уже есть, `engine.ts:110`, и сбрасывает также `square`).

**Проверка** (`smoke.ts`, в `checkSquare` или новая): наполеоника, пехота в каре, залп уничтожает её → `tile.square` ложно.

---

## Этап 5. Комнаты: выход из старой комнаты, переподключение, вкладки

### 5.1. Движок: разделить «отключился» и «удалён»
`shared/src/engine.ts` `removePlayer` (`:257`):

- Добавь `export function markDisconnected(state, id): void` — просто `player.connected = false` (для любых фаз; для `isHotseatRival` — ничего).
- `removePlayer` оставь как есть по смыслу (в лобби удаляет игрока и передаёт хоста), но вызывать его сервер теперь будет **только** по истечении grace-периода (5.3).
- Экспортируй `markDisconnected` из `shared/src/index.ts` (если там `export *` — ничего делать не надо, проверь).

### 5.2. Сервер: учёт сокетов и выход из комнаты
В `server/src/index.ts`:

1. Карта офлайна: `const offlineSince = new Map<string, number>();` ключ — `` `${roomCode}\n${userId}` ``.
2. Helper `async function userHasOtherSocket(roomCode, userId): Promise<boolean>` — `io.in(roomCode).fetchSockets()` и поиск сокета с `data.user.id === userId`. (В обработчике `disconnect` отключившийся сокет уже вышел из комнат, так что его в выборке нет.)
3. Helper `async function leaveRoom(socket, roomCode)`:
   - `socket.leave(roomCode)`;
   - если у пользователя больше нет сокетов в этой комнате → `markDisconnected(state, user.id)`, `offlineSince.set(key, Date.now())`, `pushState(state)`.
4. Helper `enterRoom(state)` вместо дублирующегося кода в `joinState` (`:88-89`) и `room:solo` (`:105-106`):
   - если `data.roomCode` задан и `!== state.roomCode` → `await leaveRoom(socket, data.roomCode)`;
   - `data.roomCode = state.roomCode; socket.join(state.roomCode); offlineSince.delete(key)`.
5. Обработчик `disconnect` (`:154-161`): вместо `removePlayer` → та же логика, что в `leaveRoom` (без `socket.leave`).
6. Новое событие `room:leave` (через `safe`): если `data.roomCode` → `leaveRoom`, `data.roomCode = undefined`, `reply({ ok: true, state: null as any })` — лучше расширь тип `Ack`, чтобы `state` мог отсутствовать для этого события, или отвечай `{ ok: true }` отдельным типом. Не ломай существующий `AckResponse` на клиенте (`client/src/net.ts:6`).

### 5.3. Сервер: периодическая уборка («sweeper»)
`server/src/rooms.ts`: добавь `export function listRooms(): GameState[]` — **без** обновления `updatedAt` (в отличие от `getRoom`).

В `server/src/index.ts` — `setInterval(sweep, 10_000)` с константами наверху файла:

```ts
/** Сколько ждать вернувшегося игрока в лобби, прежде чем освободить место. */
const LOBBY_GRACE_MS = 90_000;
```

Логика `sweep()` для лобби: для каждого игрока с `connected === false` и `offlineSince` старше `LOBBY_GRACE_MS` → `removePlayer(state, id)`, удалить ключ, `pushState(state)`. Так перезагрузка страницы больше не отнимает у хоста права и место.

Этап 6 добавит в тот же `sweep()` логику для идущей партии.

### 5.4. Клиент
`client/src/App.tsx`:

1. Фильтр чужих комнат (`:71-74`): в обработчиках `state` и `update` игнорировать состояние, если `roomRef.current && next.roomCode !== roomRef.current`.
2. Запоминание последней комнаты: ключ `` `tge-last-room:${me.id}` `` в `localStorage` (ключ с id пользователя — чтобы в dev две вкладки с разными `?dev=` не мешали друг другу). Все обращения к `localStorage` — в `try/catch`.
   - при каждом `setState(s)` с `s` не `null` → записать `s.roomCode`;
   - в эффекте авто-входа (`:139-146`): если `roomCodeFromEnvironment()` пуст, взять код из `localStorage` и попробовать `room:join` **без тоста при ошибке**; при ошибке — удалить ключ.
3. `leaveRoom()`: `request(socket, 'room:leave', {})`, затем `setState(null)`, удалить ключ из `localStorage`.
4. Передать `onExit={leaveRoom}` в `GameScreen` и `Lobby`.

`client/src/components/GameScreen.tsx`:
- В `Props` (`:63`) добавить `onExit: () => void`.
- На экране победы (`:851-859`) добавить кнопку `<button className="btn primary" onClick={onExit}>В меню</button>`.

`client/src/components/Lobby.tsx`:
- В `Props` (`:19`) добавить `onExit: () => void`; в экране комнаты (рядом с кнопкой «Скопировать код», ~`:360-385`) — кнопка «Выйти в меню» (класс `btn`, как у соседних кнопок).

### 5.5. Проверки
- `smoke.ts`: `markDisconnected` в лобби не удаляет игрока и не меняет `hostId`; `addPlayer` того же id после этого ставит `connected = true`.
- Ручная проверка в dev (`npm run dev`, две вкладки `?dev=alice` и `?dev=bob&room=КОД`):
  1. alice создаёт комнату, bob входит; alice перезагружает страницу → через ≤ 90 с alice снова хост (по коду из localStorage).
  2. alice создаёт вторую комнату → больше не получает обновлений первой.
  3. Кнопка «Выйти в меню» в лобби и на экране победы возвращает в меню.

---

## Этап 6. Игра не должна зависать из-за ушедшего игрока

Добавь в `sweep()` из этапа 5.3 (только для `state.phase === 'playing'` и **не** для `state.settings.hotseat` — в соло ждать некого):

```ts
/** Офлайн-игрок пропускает ход, чтобы партия не стояла. */
const TURN_SKIP_OFFLINE_MS = 180_000;
/** Сколько ждать ответа обороны про каре. */
const SQUARE_REPLY_MS = 60_000;
```

1. **Каре.** Если `state.pendingSquare`:
   - запомни время первого обнаружения: `const squareSeenAt = new Map<string, number>()` по `roomCode` (удаляй ключ, когда `pendingSquare` пуст);
   - если защитник (`pendingSquare.defenderId`) офлайн **или** прошло `SQUARE_REPLY_MS` → `applyAction(state, defenderId, { type: 'squareReply', form: false })`, затем `autoEndTurnIfExhausted(state)` и `pushState(state, { fx: result.fx })`.
2. **Пропуск хода.** Иначе, если текущий игрок (`currentPlayer`) `connected === false`, его `offlineSince` старше `TURN_SKIP_OFFLINE_MS`, **и** хотя бы один другой живой игрок онлайн → `applyAction(state, current.id, { type: 'endTurn' })`, в журнал это попадёт через обычный лог следующего хода; `pushState(state)`.
   - если `offlineSince` для текущего офлайн-игрока нет (например, после рестарта логики) — выставь `Date.now()` и жди.
3. `currentPlayer` уже экспортируется из `engine.ts:159` — проверь, что он доступен через `@tge/shared`.

Ручная проверка: dev, две вкладки, партия идёт, закрыть вкладку того, чей ход → через ~3 мин ход переходит второму. Для быстрой проверки временно уменьши константу, потом **верни** 180 000.

---

## Этап 7. Бот

Файл `server/src/bot.ts`.

### 7.1. Группы
Кнопки `web_app` в Telegram разрешены только в личных чатах. В группе `ctx.reply(... webApp ...)` падает с ошибкой, пользователь ничего не видит.

- Добавь `const isPrivate = (ctx) => ctx.chat?.type === 'private';`
- `openKeyboard(code)` и `playKeyboard()` превратить в функции от `ctx` (или флага `private`): в личке — как сейчас; в группе — вместо `.webApp(...)` кнопка `.url('🎮 Открыть игру', inviteLink(code))` (для `playKeyboard` — `https://t.me/${me.username}`). URL-кнопки в группах разрешены.
- Применить в `/start`, `/play`, `/newgame`, `/join`.

### 7.2. Устойчивый запуск
- `setMyCommands` и `setChatMenuButton` (`:102-117`) — каждый в своём `try/catch` с `console.error`, чтобы их ошибка не отменяла запуск бота.
- `void bot.start(...)` (`:119`) → `bot.start(...).catch((err) => console.error('[bot] polling остановлен:', err))`. Сейчас отклонённый промис (например, 409 Conflict — второй экземпляр бота) даёт `unhandledRejection`.
- В `server/src/index.ts:182-190`: если `startBot` упал (нет сети при старте, `getMe` не ответил) — повторить через 15 с, бесконечно, с логом каждой попытки. Простая рекурсивная функция `launchBot()` с `setTimeout`.

### 7.3. Прямые ссылки в Mini App — **спросить пользователя**
`WEBAPP_SHORT_NAME` (на проде `play`) сейчас не используется, приглашения ведут в чат бота (`?start=`). Прямая ссылка `https://t.me/<bot>/<shortName>?startapp=<код>` открывает игру сразу, клиент уже умеет читать `start_param` (`client/src/telegram.ts:31`). Но это работает, только если Mini App с таким short name реально создан в BotFather. **Спроси пользователя**, создан ли он. Если да — `inviteLink` строить через `startapp`, иначе оставить как есть и поменять дефолт `shortName` на `''` в `index.ts:186`.

---

## Этап 8. Авторизация и конфиг

1. `.env.example`: `DEV_MODE=1` → `DEV_MODE=0`, комментарий «1 — только локально, на проде всегда 0».
2. `server/src/index.ts` при старте: если `DEV_MODE && (process.env.WEBAPP_URL ?? '').startsWith('https://')` → громкий `console.warn('[server] ВНИМАНИЕ: DEV_MODE включён при публичном WEBAPP_URL — вход без подписи Telegram!')`.
3. `server/src/auth.ts:8` `MAX_AUTH_AGE_SECONDS`: поднять до `7 * 24 * 60 * 60`. Причина: `initData` берётся один раз при открытии Mini App (`client/src/net.ts:17`) и не обновляется; при обрыве связи через сутки переподключение невозможно.
4. `client/src/App.tsx:148-155` экран `fatal`: добавить подсказку «Закройте игру и откройте её заново из чата с ботом».

---

## Этап 9. Автоконец хода и бесплатное продолжение похода — **спросить пользователя**

**Наблюдение.** `move` не тратит действие, если отряд уже в походе (`wingsAlreadyMarching`, `engine.ts:1141-1145`). Но `autoEndTurnIfExhausted` (`engine.ts:1486`) завершает ход сразу, как только `actionsLeft <= 0`, — продолжить поход уже нельзя.

Это вопрос геймдизайна. **Спроси пользователя**, какое поведение нужно:
- (а) оставить как есть;
- (б) не завершать ход автоматически, пока у игрока есть отряды, которые могут бесплатно продолжить поход.

Если (б): в `autoEndTurnIfExhausted` перед `nextTurn` проверить, что нет своей клетки (`ownerId === player.id`, `routedTurns === 0`, `!squarePinned(state, tile)`), у которой хоть одна «крыло» из `ensureWings(tile)` удовлетворяет `wingsAlreadyMarching([wing], speedBonus(tile), era(state))`. Добавить проверку в `checkActionLimit` (`smoke.ts`), не сломав существующие ассерты.

---

## Этап 10. Документация и итог

1. Обнови номера строк в `docs/MAP.md` и профильных документах; добавь в `docs/server.md` событие `room:leave`, `safe()`, `sweep()` и константы таймаутов; в `docs/engine.md` — `validate.ts`, `markDisconnected`.
2. Финальный прогон: `npm run typecheck`, `npm run smoke` (и `npm run abuse`, если делал).
3. Отчёт пользователю — коротко, по-русски, нумерованный список изменений. Отдельной строкой — что не сделано и почему (журнал `log` не маскируется; этапы 7.3 и 9 — если пользователь не ответил).

## Чек-лист приёмки

- [ ] Кривые payload'ы любых событий не роняют процесс; `/health` жив.
- [ ] `configure {hotseat}` игнорируется.
- [ ] Клиент не получает `seed` до конца партии и не видит чужие ресурсы при тумане.
- [ ] После уничтожения залпом на клетке нет `square`.
- [ ] Перезагрузка страницы в лобби не отнимает права хоста; смена комнаты не присылает чужие обновления; есть «Выйти в меню» и «В меню» на экране победы.
- [ ] Офлайн-игрок через 3 мин пропускает ход; каре решается автоматически через 60 с или сразу, если защитник офлайн.
- [ ] В группе бот отвечает URL-кнопкой, а не падает; ошибки запуска бота не роняют сервер, бот переподключается.
- [ ] `.env.example` с `DEV_MODE=0`; `typecheck` и `smoke` зелёные.
