# Клиент — Telegram Mini App (`client/`)

React 18 + Vite 6, без роутера и стейт-менеджера. Пакет `@tge/client`, импортирует правила из `@tge/shared`.
Dev: `vite` на :5173, проксирует `/socket.io` на :3000 (`vite.config.ts`). Прод: `vite build` → `client/dist`, раздаёт сервер.

## Файлы

| Файл | Строк | Роль |
|---|---|---|
| `index.html` | 13 | подключает `telegram-web-app.js`, `#root` |
| `src/main.tsx` | 10 | `initTelegram()` + рендер `<App/>` (без StrictMode — ломает сокет) |
| `src/telegram.ts` | 62 | `tg` (= `window.Telegram.WebApp`), `initTelegram`, `roomCodeFromEnvironment` (start_param → `?room=`), `haptic`, `hapticResult`, `devId` (`?dev=` или sessionStorage) |
| `src/net.ts` | 31 | `connect()` — socket.io (polling → websocket, auth `{initData, devId}`), `request(socket, event, payload)` — ack с таймаутом 8 с |
| `src/App.tsx` | 274 | корень приложения |
| `src/components/Lobby.tsx` | 426 | меню + лобби |
| `src/components/GameScreen.tsx` | 1302 | игровой экран |
| `src/components/MapBoard.tsx` | 285 | гекс-карта (и в лобби, и в игре) |
| `src/components/TechModal.tsx` | 49 | окно технологий |
| `src/components/Toast.tsx` | 17 | всплывающее сообщение 2.6 с |
| `src/styles.css` | 1656 | все стили; тема по `data-scheme` от Telegram |

## App.tsx

| Строки | Что |
|---|---|
| 22-29 | Состояние: сокет, `connected`, `me`, `state` (GameState), `toast`, `fatal`, `fx` |
| 33-40 | `roomRef`/`meRef` — код комнаты и id пользователя для обработчиков socket, которые переживают разрывы связи |
| 42-60 | `rememberRoom`/`forgetRoom` — код последней комнаты в `localStorage` под ключом `tge-last-room:<userId>` (свой на каждого пользователя, чтобы dev-вкладки с разными `?dev=` не путались); все обращения к `localStorage` в `try/catch` |
| 62-85 | `applyState`/`applyWithFx` — ставят состояние, запоминают комнату (`rememberRoom`), `applyWithFx` ещё держит `fx` 820–1000 мс для анимации |
| 87-127 | Подписки: `connect` (авто-`room:join` после разрыва), `me`, `state`/`update` — **игнорируют чужую комнату** (`roomRef.current && next.roomCode !== roomRef.current`), чтобы обновления закрытой/сменённой комнаты не подмешивались, `connect_error` (4 ошибки → экран «Не удалось подключиться») |
| 129-189 | Действия: `joinRoom`, `createRoom`, `createSolo`, `startGame`, `lobbyAct`, `act` (ошибка → тост + вибрация) |
| 191-199 | `leaveRoom` — `room:leave` на сервер, `setState(null)`, забыть код комнаты; передаётся в `Lobby`/`GameScreen` как `onExit` |
| 202-226 | Авто-вход: код из ссылки (`startapp`/`?room=`) в приоритете; иначе код из `localStorage` — без тоста при ошибке, просто забываем его |
| 246-273 | Рендер: нет state или `lobby` → `<Lobby onExit={leaveRoom}>`, иначе `<GameScreen meId={actingPlayerId(...)} onExit={leaveRoom}>` + `<Toast>` |

## Lobby.tsx

- `:38-100` — без комнаты: меню «Создать», «Сам с собой» (hotseat), поле кода + «Войти».
- `:100` `send(action)` → `onLobby`.
- `:107-154` — «Комната КОД», список игроков (метки хост/админ/вы), кнопки назначения админов, пустые слоты.
- `:155-338` — «Настройки партии»: эпоха, размер карты, туман, режим рельефа, раунды, действия, старт. ресурсы (`Stepper` `:393`).
- `:339-358` — карта-превью / редактор рельефа (кисти `BRUSHES` `:29`, `paint` по клику).
- `:360-395` — нижняя панель: «Скопировать код», «Выйти в меню» (`onExit`, любой участник), «Начать» (только хост, ≥2 игроков).

## GameScreen.tsx

Верх файла — чистые хелперы подсказок:
`maxAffordable` `:75`, `fmtStat` `:83`, `mpSpan` `:87`, `beatsExplain` `:94`, `chargeHint` `:117`, `terrainHint` `:122`,
`unitStatChips` `:144`, `ExplainChips` `:194`, `turnsLabel` `:225`, `ArmyChips` `:231`.

Компонент `GameScreen` `:246`:

| Строки | Что |
|---|---|
| 247-258 | Локальное состояние: `selected`, `mode` ('none'/'move'/'shoot'), `moveFrom/moveTarget/moveCount/moveUnit`, `supportKeys`, найм, `sheet`, `showTech` |
| 259-268 | Кто я, чей ход, hotseat, `pendingSquare`, эпоха |
| 288-334 | Выбранная/исходная/целевая клетки, крылья, набег, стоимость хода, предупреждения о смешении |
| 335-336 | `income`, `upkeep` |
| 338-376 | Подсветка: досягаемые (`walkReachable`), набег, цели залпа |
| 378-386 | `resetPick` |
| 387-392 | `run(action)` — вызов `act` |
| 393-425 | `pick(tile)` — клик по клетке в зависимости от режима |
| 426-448 | `confirmMove` — отправка `move` с `supportFrom` |
| 449-475 | Можно ли нанимать/строить/назначать здесь, союзники для совместного удара |
| 480-493 | `battleForecast` — `battleForecastRatio` (командир учитывается, если уходит весь стек) |
| 500-521 | `<header className="topbar">` — ресурсы, доход, раунд, чей ход |
| 522-534 | `<MapBoard>` |
| 536-736 | `<div className="panel">` — панель хода (прогноз, кол-во, род войск, помощники) / режим залпа / `TileDetails` |
| 737-744 | Журнал `state.log` |
| 745-755 | `<footer>` — «Технологии», «Конец хода» |
| 756-824 | Модалки `RecruitSheet`, `BuildSheet`, `CommanderSheet`, `TechModal` |
| 825-851 | Диалог каре (оборона выбирает `squareReply`) |
| 853-863 | Экран победы — кнопка «В меню» (`onExit`) |

Подкомпоненты: `TileDetails` `:882` (информация о клетке + кнопки действий), `RecruitSheet` `:1104`,
`BuildSheet` `:1218`, `CommanderSheet` `:1264`.

## MapBoard.tsx

- Props `:23`: `state, meId, selected, highlighted, chargeHighlighted, supportHighlighted, highlightKind, fx, onPick`.
- `TERRAIN_ICON` `:35`, `tileSelector` `:43`, `ShootBurst` `:47` (вспышка выстрела по типу снаряда).
- `:72-95` — один раз центрирует вид на своей столице.
- `:96-122` — расчёт позиции/угла анимации fx.
- `:140-260` — отрисовка тайлов: классы (`fog`, `in-square`, `has-commander`, `has-construction`, `capital-spot`), армия, ★, постройка/стройка, командир, каре. Во время fx армия «вычитается» из исходной клетки.
- `:261+` — летящий токен `fx-token` (классы по роду/тиру/исходу боя).
