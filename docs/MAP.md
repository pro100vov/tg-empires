# Карта кода TG Empires

> Точка входа для любой задачи. Сначала найди задачу в таблице ниже → открой указанный
> файл/строки → при необходимости загляни в подробный документ раздела.
> Номера строк обновлены после `docs/fix-plan.md` (2026-09-27, ветка `server-snapshot`, после второго прохода по ошибкам).
> Если правишь код заметно — обнови строки здесь.

Подробные документы:

| Документ | О чём |
|---|---|
| [overview.md](overview.md) | Что делает бот/игра, архитектура, поток данных, правила игры |
| [server.md](server.md) | Express + Socket.IO, Telegram-бот, авторизация, комнаты, протокол событий |
| [engine.md](engine.md) | `shared/` — все игровые правила: движок, бой, юниты, эпохи, карта, туман войны |
| [client.md](client.md) | React-клиент (Mini App): экраны, компоненты, сеть |
| [deploy.md](deploy.md) | Как запущено на сервере, env, сборка, тесты |

## Дерево проекта

```
server/src/index.ts     вход сервера: Express, Socket.IO, обработчики событий, запуск бота
server/src/bot.ts       Telegram-бот (grammY): /start /play /newgame /join /help, кнопка меню
server/src/auth.ts      проверка подписи Telegram initData, dev-вход
server/src/rooms.ts     комнаты в памяти (Map), TTL-уборщик
shared/src/types.ts     ВСЕ типы: GameState, Tile, Player, GameAction, LobbyAction, GameFx
shared/src/config.ts    константы баланса: местность, постройки, техи, старт, размеры карты
shared/src/units.ts     12 родов войск, сила армии, скорость, залпы, «крылья» (wings)
shared/src/commanders.ts 3 командира стека
shared/src/eras.ts      эпохи (античность/средневековье/наполеоника): переименования и правки статов
shared/src/engine.ts    ДВИЖОК: лобби, старт, ход, доход, бой, бегство, applyAction
shared/src/map.ts       гекс-сетка odd-r, соседи, пути, генерация карты, столицы
shared/src/vision.ts    туман войны, линия видимости, маскировка состояния, publicView (+ скрытый seed)
shared/src/rng.ts       mulberry32, seed, код комнаты
shared/src/validate.ts  проверка входящих действий от клиента (parseGameAction/parseLobbyAction)
shared/src/index.ts     реэкспорт всего shared
client/src/App.tsx      корень: сокет, состояние, переключение Lobby/GameScreen
client/src/net.ts       socket.io-клиент + request() с ack и таймаутом
client/src/telegram.ts  обёртка Telegram.WebApp, код комнаты из start_param/?room, devId
client/src/components/Lobby.tsx      меню и лобби (настройки, рисование карты)
client/src/components/GameScreen.tsx игровой экран (панели, выбор хода, найм, стройка)
client/src/components/MapBoard.tsx   отрисовка гекс-карты и анимаций fx
client/src/components/TechModal.tsx  окно технологий
client/src/components/Toast.tsx      всплывашка
client/src/styles.css   все стили
scripts/smoke.ts        тесты правил без UI (npm run smoke)
scripts/abuse.ts        кривые payload'ы против локального DEV_MODE=1 сервера (npm run abuse)
```

## Где что менять — быстрый указатель

### Telegram-бот и сервер
| Задача | Где |
|---|---|
| Текст справки бота / команды | `server/src/bot.ts:10-19` (HELP), команды `:38-96`, список меню `:102-107` |
| Ссылка-приглашение, кнопки WebApp | `server/src/bot.ts:26-36` |
| Кнопка меню «Играть» | `server/src/bot.ts:109-117` |
| Добавить новое socket-событие | `server/src/index.ts:144-278` (блок `io.on('connection')`), не забыть `parseGameAction`/`parseLobbyAction` и обёртку `safe()` |
| Проверка входящего payload перед движком | `shared/src/validate.ts` (`parseGameAction`/`parseLobbyAction`) |
| Ошибка в обработчике не должна ронять сервер | `server/src/index.ts:93-101` `safe()` |
| Выход/вход в комнату, смена вкладок | `server/src/index.ts:120-141` `leaveRoom`/`enterRoom`, событие `room:leave` `:195` |
| Офлайн-игрок: пропуск хода, каре, уборка лобби | `server/src/index.ts:280-333` `sweep()` (в соло не трогает; таймер каре — на каждое предложение) (таймауты `LOBBY_GRACE_MS`/`SQUARE_REPLY_MS`/`TURN_SKIP_OFFLINE_MS`) |
| Рассылка состояния всем в комнате | `server/src/index.ts:69-85` `pushState`/`pushStateSafe` |
| Маскировка состояния под игрока | `server/src/index.ts:63-67` `viewOf` → `shared/src/vision.ts:140 maskStateFor` + `:159 publicView` (скрывает seed) |
| Авторизация сокета | `server/src/index.ts:47-54`, `server/src/auth.ts:16` |
| Dev-вход без Telegram | `server/src/auth.ts`, флаг `DEV_MODE` |
| Время жизни комнат | `server/src/rooms.ts:4-5`, уборщик `startRoomCleanup` |
| Создание комнаты | `server/src/rooms.ts createRoom` → `shared/src/engine.ts:211 createGame` |
| Статика клиента / health | `server/src/index.ts:29-37` |

### Игровые правила (shared/src/engine.ts)
| Задача | Где |
|---|---|
| Главный обработчик действий | `applyAction` `:1002` (switch по `action.type`) |
| Конец хода | `case 'endTurn'` `:1012` → `nextTurn` `:564` |
| Изучение технологии | `case 'research'` `:1017`; стоимость `config.ts:143 techCost` |
| Постройка | `case 'build'` `:1033`; данные `config.ts:60 BUILDINGS` |
| Найм войск | `case 'recruit'` `:1054` |
| Назначение командира | `case 'appoint'` `:1079` |
| Перемещение / атака / набег | `case 'move'` `:1109-1360` (проверка ⚡ — до предложения каре) |
| Залп (стрельба) | `case 'shoot'` `:1362-1478` (цель должна быть видна) |
| Каре (наполеоника) | `case 'formSquare'` `:1480`, `'breakSquare'` `:1494`, ответ обороны `applySquareReply` `:963`, логика `:118-153` |
| Расчёт боя | `resolveBattle` `:745`; прогноз для UI `battleForecastRatio` `:935` (с командирами и бегством) |
| Бегство / отступление | `maybeRout` `:726`, `displaceArmy` `:895`, `pickFleeDestination` `:843` |
| Совместный удар соседей | `allyStacksCovering` `:673`, `pickSupportTiles` `:685` |
| Множители защиты/атаки | `defenseMultiplier` `:646`, `attackMultiplier` `:659`, `commanderBonus` `:663` |
| Начало хода: стройки, доход, голод, сброс хода войск, каре | `beginTurn` `:485` |
| Доход | `computeIncome` `:442`; содержание `upkeepFor` `:476` |
| Очки и победа | `scoreOf` `:595`, `finish` `:610`, `finishByScore` `:617` |
| Уничтожение державы (взята столица) | `eliminate` `:626` |
| Сдача | `case 'surrender'` в `applyAction` → `applySurrender` (земли — сильнейшему живому; можно не в свой ход) |
| Автоконец хода при 0 действий | `autoEndTurnIfExhausted` `:1531` |
| Лобби: игроки | `addPlayer` `:234`, `removePlayer` `:266` (опустевшее лобби → хост = следующий вошедший) |
| Лобби: настройки, рисование, reroll, админы | `applyLobbyAction` `:338`, валидация `sanitizeSettings` `:298` |
| Старт партии (столицы, порядок ходов) | `startGame` `:395` |
| Режим «сам с собой» (hotseat) | `setupHotseat` `:180`, `actingPlayerId` `:174` |
| Случайность боя | `nextRandom` `:641` (детерминированно от `state.seed`) |

### ИИ-соперники (`shared/src/ai.ts`, стратегии — [ai-strategy.md](ai-strategy.md))
| Задача | Где |
|---|---|
| Пороги по сложности | `TUNING` `ai.ts:93` |
| Контекст хода (контакт, ничья земля, сила у фронта) | `buildCtx` `:305` |
| Выбор стратегии (экспансия/фронт/наступление/оборона) | `chooseStrategy` `:387`, точка сбора `pickRally` `:415` |
| Гарнизон столицы | `minGarrison`/`garrisonOf` `:449-479` |
| Наём (всадники, армия, гарнизон) | `riderRecruitCands` `:659`, `recruitCands` `:684` |
| Стройка (депо-казармы, частокол, фермы, шахты) | `buildCands` `:751` |
| Табун конницы и захват земли | `bestRide` `:1043`, `expandCands` `:1088` |
| Резервы к фронту, наступление кулаком | `reinforceCands` `:1185`, `advanceCands` `:1231` |
| План и шаг ИИ | `planAiTurn` `:1288`, `stepAi` `:1354`; темп на сервере — `server/src/aiRunner.ts` |

### Баланс и данные
| Задача | Где |
|---|---|
| Статы/цены 12 родов войск | `shared/src/units.ts:57-250 UNITS` |
| Константы набега, каре, залпа после хода | `shared/src/units.ts:44-55` |
| Камень-ножницы-бумага классов | `shared/src/units.ts:279 BEATS`, `classMod` `:375` |
| Бой по местности | `terrainFightMod` `units.ts:411`, `terrainVolleyMod` `:459` |
| Сила армии | `armyPower` `units.ts:475` |
| Стоимость хода по местности, остановка коней в лесу | `units.ts:548-598` |
| Дальность стрельбы, артиллерия | `units.ts:600-668` |
| «Крылья» (группы с разным запасом хода) | `units.ts:700-828` |
| Местность (доход, защита, укрытие) | `shared/src/config.ts:46 TERRAIN` |
| Постройки | `shared/src/config.ts:60 BUILDINGS` |
| Технологии | `shared/src/config.ts:130 TECHS` |
| Стартовые ресурсы/армия, действий за ход, лимиты | `shared/src/config.ts:3-27`, `defaultGameSettings` `:141` |
| Цвета игроков | `shared/src/config.ts:157` |
| Командиры | `shared/src/commanders.ts:18` |
| Эпохи и переименования | `shared/src/eras.ts:55 ERAS`, `MEDIEVAL_UNITS :119`, `NAPOLEONIC_UNITS :209`, постройки/командиры/техи `:333-385` |
| Получить данные с учётом эпохи | `unitsFor` `units.ts:252`, `buildingsFor/commandersFor/techsFor` `eras.ts:387-405` |

### Карта и видимость
| Задача | Где |
|---|---|
| Геометрия гексов, соседи, дистанция | `shared/src/map.ts:6-90` |
| Путь, досягаемые клетки | `walkPath` `map.ts:115`, `walkReachable` `:165` |
| Проверка пути набега | `chargePathOpen` `map.ts:96` |
| Генерация карты | `generateTiles` `map.ts:332`, `rollTerrain` `:210`, `smooth` `:224` |
| Позиции столиц | `capitalSpots` `map.ts:320`, расчистка `ensureCapitalApproaches` `:289` |
| Пиксельные размеры доски | `hexBoardSize` `map.ts:193`, `hexTileBox` `:201`, `config.ts:12-15` |
| Туман войны / обзор | `shared/src/vision.ts` (дальность `:7`, LoS `:33`, маска `:140`, маска fx `:152`) |

### Клиент
| Задача | Где |
|---|---|
| Подключение / переподключение / авто-вход в комнату | `client/src/App.tsx:87-128`, `:205-229` |
| Вызов действий на сервер | `App.tsx:129-201` (`act`, `lobbyAct`, …) |
| Анимация хода (fx) | `App.tsx:26-37`, рендер `MapBoard.tsx:261+` |
| Меню (создать/соло/войти по коду) | `Lobby.tsx:38-100` |
| Настройки партии в лобби | `Lobby.tsx:155-338`, `Stepper` `:393` |
| Редактор рельефа | `Lobby.tsx:339-358` |
| Верхняя панель ресурсов | `GameScreen.tsx:505-526` |
| Логика выбора клеток (pick/move/shoot) | `GameScreen.tsx:381-452` (`resetPick` :381, `run` :390, `pick` :396, `confirmMove` :429) |
| Подсветка досягаемых клеток | `GameScreen.tsx:341-379` |
| Прогноз боя в панели | `GameScreen.tsx:480-493`, вывод `:540-664` |
| Инфо о клетке | `TileDetails` `GameScreen.tsx:892-1095` |
| Нижние кнопки (техи, конец хода) | `GameScreen.tsx:750-757` |
| Окно найма | `RecruitSheet` `GameScreen.tsx:1116` |
| Окно стройки | `BuildSheet` `GameScreen.tsx:1230` |
| Окно командира | `CommanderSheet` `GameScreen.tsx:1276` |
| Диалог каре / экран победы | `GameScreen.tsx:831-869` |
| Сдаться | `GameScreen.tsx` кнопка 🏳️ в topbar + подтверждение → `{ type: 'surrender' }` |
| Подсказки по статам юнитов | `GameScreen.tsx:94-245` |
| Рисование тайла (иконки, туман, столица, стройка) | `MapBoard.tsx:140-260` |
| Центрирование на столице | `MapBoard.tsx:72-95` |
| Стили | `client/src/styles.css` (меню `:71`, кнопки `:136`, игра `:296`, модалки `:1535`) |

### Тесты
| Задача | Где |
|---|---|
| Прогон правил | `scripts/smoke.ts`, список проверок `:2058-2091` |
| Добавить проверку | новая функция `checkXxx()` + вызов в конце файла |

## Типичные сценарии изменений

- **Новое игровое действие**: тип в `types.ts:140 GameAction` → `case` в `engine.ts applyAction` → кнопка в `GameScreen.tsx` через `run({type:...})` → проверка в `smoke.ts`. Сервер трогать не надо — `game:action` generic.
- **Новая постройка**: `types.ts:3 BuildingType` → `config.ts BUILDINGS` → (опц.) `eras.ts ERA_BUILDINGS` → стиль `tile-building-<id>` в `styles.css`.
- **Новый род войск**: `types.ts:9 UnitId` → `units.ts UNIT_IDS/UNITS` → `eras.ts MEDIEVAL_UNITS/NAPOLEONIC_UNITS`.
- **Новая настройка лобби**: `types.ts:85 GameSettings` → `config.ts defaultGameSettings` → `engine.ts sanitizeSettings` → UI в `Lobby.tsx`.
- **Новая команда бота**: `bot.ts` (`bot.command(...)` + `setMyCommands`).
- **Новое socket-событие**: `server/src/index.ts` в `io.on('connection')` + вызов `request(socket, 'event', payload)` в `App.tsx`.

## Новые файлы (план функций 2026-09-29)

`server/src/`: storage, users, notify, turnClock, rematch, aiRunner, hub. `shared/src/`: events, diplomacy, ai. `client/src/`: labels.ts; components — LogSheet, EndScreen, EventCard, DiplomacySheet, MiniMap, Tutorial. Номера строк выше могли сдвинуться в `engine.ts` — ищи по имени функции. Подробности — в конце `server.md`, `engine.md`, `client.md`.

### Варгейм (`shared/src/wargame.ts`)
| Задача | Где |
|---|---|
| Цены отрядов/командиров/укреплений, размер отряда | `wargame.ts` `SQUAD_SIZE`, `squadPrice`, `commanderPrice`, `fortPrice` |
| Зоны расстановки | `wargame.ts` `zoneOwnerAt`, `deployZone` |
| Закупка и «Готов» | `engine.ts` `applyDeployAction` → `wargame.ts deployStep`; старт — `startDeploy`, `beginBattle` |
| Автозакупка (ИИ, «Авто», офлайн) | `wargame.ts autoDeploy`, `engine.ts forceDeployReady` |
| Счёт убитых отрядов, выбывание, победа | `engine.ts` `applyAction` (обёртка) → `settleWargame` |
| Лечение отрядов | `engine.ts restSquads` (из `nextTurn`) |
| Укрепление из запаса | `engine.ts placeWarFort` |
| ИИ в бою | `ai.ts planWargameTurn`, `warAdvanceCands`, `warFortCands` |
| Экран закупки | `client/src/components/DeployScreen.tsx` |
| Настройки в лобби | `Lobby.tsx` блоки «Режим», «Капитал и победа» |
| Сервер / бот | `index.ts` `deploy:action`, `sweep` (фаза deploy); `bot.ts /wargame` |
| Тесты | `scripts/wargame-checks.ts` |
