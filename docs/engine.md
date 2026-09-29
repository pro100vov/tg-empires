# Игровые правила (`shared/src/`, пакет `@tge/shared`)

Чистый TypeScript без зависимостей. Импортируется сервером и клиентом через `@tge/shared`
(`index.ts` реэкспортирует все модули). Все функции движка **мутируют** переданный `GameState`
и возвращают `ActionResult = {ok:true, events, fx?} | {ok:false, error}` (ошибки — по-русски, показываются в тосте).

## types.ts — модель данных

- `GameState` `:119` — комната целиком: `roomCode, hostId, adminIds, settings, phase ('lobby'|'playing'|'finished'),
  seed, width, height, tiles[], players[], order[] (порядок ходов), turnIndex, round, maxRounds, log[], winnerId, pendingSquare`.
- `Tile` `:41` — клетка: `terrain, ownerId, building, construction, army, capitalOf, movesLeft, shotsLeft,
  commander, routedTurns (паника), square (каре), wings (группы с разным запасом хода)`.
- `Player` `:69` — `resources {gold,food,iron}, tech {attack,defense,economy,logistics}, actionsLeft, alive, connected, seenBuildings`.
- `Army` = `Partial<Record<UnitId, number>>` — сколько отрядов каждого рода.
- `GameSettings` `:85` — настройки лобби (размер карты, режим рельефа, туман, раунды, старт, действия, hotseat, эпоха).
- `GameAction` `:140` — `move | shoot | build | recruit | appoint | research | formSquare | breakSquare | squareReply | endTurn`.
- `LobbyAction` `:152` — `configure | paint | reroll | setAdmin`.
- `GameFx` `:158` — описание анимации последнего действия (move/shoot/charge + исход боя).

## engine.ts — движок (≈1500 строк)

| Строки | Блок |
|---|---|
| 76-116 | Хелперы: `era`, `flavorOf` (тексты эпохи), `unitsOf/buildingsOf/commandersOf` (данные с учётом эпохи), `stackSpeed`, `clearMarch` |
| 118-153 | Каре: `canFormSquare`, `enemyCavalryAdjacent`, `squarePinned`, `shouldOfferSquare`, `canAnswerSquare` |
| 155-188 | Игроки: `playerById`, `currentPlayer`, hotseat (`hotseatRivalId`, `actingPlayerId`, `setupHotseat`) |
| 190-208 | Ресурсы: `canAfford`, `pay`, `multiplyCost` |
| 210-231 | `createGame` — новое лобби, карта генерится сразу на 4 игроков |
| 233-256 | `addPlayer` (переподключение = connected=true) |
| 258-262 | `markDisconnected(state, id)` — только `connected=false`, место и права не отнимает (для этого есть `removePlayer`, которым пользуется только уборщик сервера по TTL) |
| 266-287 | `removePlayer` (в лобби реально удаляет и передаёт хоста; если ушли все — `hostId=''`, хостом станет следующий вошедший в `addPlayer`), `isLobbyAdmin` |
| 295-332 | `sanitizeSettings` — границы: карта 8-14, раунды 15-60, золото 20-200, еда/железо 0-150, армия 2-20, действия 3-8. `hotseat` сюда **не входит** — его выставляет только `setupHotseat`, иначе через `configure` можно было включить «сам с собой» в обычной комнате или выключить в соло |
| 335-390 | `applyLobbyAction` — `setAdmin` (только хост), `reroll`, `paint` (рисование рельефа, переключает в custom), `configure` |
| 392-437 | `startGame` — генерация/ресайз карты, столицы с фортом и стартовой армией, случайный порядок ходов, `beginTurn` |
| 439-475 | Экономика: `computeIncome` (местность + постройки + столица `CAPITAL_INCOME` +5🪙+2🌾+2🔩, ×(1+0.15·economy)), `totalArmy`, `upkeepFor` (сумма `UNITS[id].upkeep` по отрядам, вверх) |
| 477-480 | `log` — журнал, максимум 100 записей |
| 482-559 | `beginTurn` — стройки −1, доход, содержание/голод, сброс `wings` (routed → 0 хода), действия, удержание каре (1⚡ за каре) |
| 561-590 | `nextTurn` — уменьшение паники, проверка победы, следующий живой игрок, новый раунд / конец по очкам |
| 595-639 | `scoreOf` (3 за клетку, +2 постройка, +10 столица, +армия, +3 за уровень техи), `finish`, `finishByScore`, `eliminate` (клетки павшей чистит `clearMarch`, в т.ч. каре) |
| 641-670 | Случайность `nextRandom`, `defenseMultiplier` (местность + постройка + техи защиты), `attackMultiplier`, `commanderBonus` |
| 672-714 | Совместный удар: `allyStacksCovering`, `pickSupportTiles`, `splitByRatio` (делёж выживших) |
| 716-812 | Бой: `maybeRout` (шанс паники 8-72%), `routTurnsFromLoss`, **`resolveBattle`** (сила, потери, каре режет потери, бегство) |
| 814-932 | Бегство: `displaceArmy` → `pickFleeDestination` (BFS прочь от угрозы), потери 35% если враг с тыла |
| 935-961 | `battleForecastRatio` — прогноз без рандома для UI (те же множители, что в бою: командиры, бегство ×0.65) |
| 963-1000 | `applySquareReply` — оборона ответила про каре, повторно применяет отложенный `move`; если он уже невозможен — «Атака отменена» и `ok:true`, чтобы состояние разослали |
| 990-1491 | **`applyAction`** — switch по действиям (см. ниже) |
| 1499-1511 | `hasFreeContinuingMarch` — есть ли своя клетка с «крылом», которое может бесплатно продолжить поход (`wingsAlreadyMarching`) |
| 1513-1519 | `autoEndTurnIfExhausted` — 0 действий, нет незавершённого каре **и** нет бесплатного продолжения похода → `nextTurn`. Иначе ход не завершается автоматически: `move` не тратит действие, если крыло уже маршировало, и раньше это продолжение обрывалось лишним автоконцом хода |
| 1521 | `coordKey` → `"x,y"` |

Второй рубеж защиты внутри `applyAction`: поиск по словарям (`units[...]`, `buildingsOf(state)[...]`,
`commandersOf(state)[...]`, `techsFor(...)[...]`) всегда идёт через `Object.hasOwn(dict, key)`, а не
`dict[key]`/`v in dict` — иначе значение вроде `'constructor'` находит унаследованное поле объекта-словаря
и проходит проверку на истинность. Первый рубеж — `shared/src/validate.ts` (см. ниже), но `applyAction`
можно вызвать и напрямую (smoke-тесты, hotseat), поэтому проверка нужна и здесь.

### applyAction — ветки

| Ветка | Строки | Суть |
|---|---|---|
| `squareReply` | 992 | в обход проверки «чей ход» |
| `endTurn` | 1000 | `nextTurn` |
| `research` | 1005 | 1⚡, `Object.hasOwn(techs, action.tech)`, цена `techCost(level)` = 30·(ур+1)🪙 + 10·(ур+1)🌾 + 12·(ур+1)🔩 |
| `build` | 1021 | 1⚡, `Object.hasOwn(buildings, action.building)`, своя клетка без постройки → `construction` на `buildTurns` ходов |
| `recruit` | 1042 | 1⚡, только в столице или казармах; `Object.hasOwn(units, action.unit)`; новое «крыло» с полным ходом |
| `appoint` | 1067 | 1⚡, `Object.hasOwn(commanders, action.commander)`; командир на стек в столице/казармах; +ход неходившим крыльям |
| `move` | 1109 | проверки → набег (dist=2, не в лес, путь открыт, все умеют charge) → проверка 1⚡ (если стек ещё не маршировал) → предложение каре → списание 1⚡ → мирный ход / бой (`resolveBattle`) / захват пустой клетки; взятие столицы → `eliminate` |
| `shoot` | 1362 | 1⚡, стрелки в дальности (`volleyArmy`), цель должна быть видна (`canWatchTile` + `canSeeArmyOn`, при тумане), укрытие цели, штраф после марша, тяжёлая артиллерия после хода не стреляет; конные лучники сохраняют ход (kite); полное уничтожение гарнизона идёт через `clearMarch(to)` (не оставляет ложный `square`); возможна паника гарнизона |
| `formSquare` / `breakSquare` | 1462 / 1476 | только наполеоника; нельзя разойти рядом с вражеской конницей |

## validate.ts — проверка входящих действий

Первый рубеж защиты от кривых/враждебных payload'ов до движка. Экспортирует `parseGameAction(raw): GameAction | null`
и `parseLobbyAction(raw): LobbyAction | null` — обе принимают `unknown`, ничего не бросают, на любой мусор
(не тот тип, отсутствующее обязательное поле, лишний `type`, `Coord` вне `0..63`, `count` вне `1..10000`,
`unit`/`building`/`commander`/`tech`/`terrain` не из списка известных значений) возвращают `null` и
пересобирают результат только из известных полей — лишние поля клиента отбрасываются. Списки допустимых
значений — константы `as const` (`UNIT_IDS`, `COMMANDER_IDS` переиспользованы из `units.ts`/`commanders.ts`,
остальные — `BUILDING_IDS`/`TECH_IDS`/`TERRAIN_IDS` объявлены на месте). Использует только
`array.includes(v)`, никогда `v in obj`/`obj[v]` — иначе `'constructor'` проходит проверку. Используется
сервером (`server/src/index.ts`) перед `applyAction`/`applyLobbyAction`.

## units.ts — войска (≈830 строк)

- `UNIT_IDS` `:5`, `UnitInfo` `:20`, **`UNITS`** `:57-250` — базовые (античные) статы 12 родов.
  | род | атк/защ | ход | дальн. | цена 🪙/🔩 |
  |---|---|---|---|---|
  | лёгк./ср./тяж. пехота | 0.8/0.75 · 1/1.1 · 1.2/1.55 | 1 | — | 5/2 · 8/4 · 14/8 |
  | лёгк./ср./тяж. конница (charge) | 0.95/0.65 · 1.25/0.85 · 1.55/1.05 | 3·2·2 | — | 7/3 · 12/5 · 18/9 |
  | лёгк./ср./тяж. лучники | 0.9/0.55 · 1.2/0.7 · 1.45/0.85 | 2·1·1 | 2 | 6/3 · 10/4 · 16/7 |
  | лёгк./ср./тяж. конные лучники | 0.95/0.5 · 1.2/0.6 · 1.4/0.75 | 3·3·2 | 2 | 9/4 · 14/6 · 20/8 |
- Константы `:44-55`: `CHARGE_ATTACK=1.2`, `CHARGE_COST=2`, `SQUARE_CAVALRY_ATTACK=0.32`, `SQUARE_MELEE=0.55`, `SQUARE_CASUALTY=0.4`, `MOVED_VOLLEY=0.65`.
- `unitsFor(era)` `:252` — статы с правками эпохи; `unitOf` `:274`.
- `BEATS` `:279` + `classMod` `:375` — камень-ножницы-бумага.
- Операции с армиями `:285-372`: `armyCount`, `addToArmy`, `mergeArmies`, `takeArmy` (снимает с лёгких), `scaleArmy`, `dominantUnit/Class`.
- Местность в бою: `terrainFightMod` `:411`, `terrainVolleyMod` `:459`; **`armyPower`** `:475`.
- Движение `:504-613`: `unitSpeed`, `armyCanCharge`, `armyCanKite`, `enterMoveCost`, `spentMoveCost`, `enterHaltsArmy` (тяж./ср. конница стопорится в лесу), `armySpeed`, `mixWarning`.
- Стрельба `:600-702`: `unitRange`, `armyRange` (+1 с холмов), `unitShotKind`, `isArtilleryUnit`, `armyHasHeavyArtillery`, `volleyArmy`, `archerArmy`.
- **Wings** `:704-828`: стек на клетке = набор крыльев с разным `movesLeft/shotsLeft`. `ensureWings`, `writeWings`
  (синхронизирует `tile.army/movesLeft/shotsLeft`), `takeFromWings`, `spendWingMove`, `mobileCount`, `wingsAlreadyMarching`.
- `DEFAULT_UNIT = 'medium_infantry'`.

## commanders.ts
`COMMANDERS` `:18`: warlord (Воевода, +22% атк), marshal (Маршал, +25% защ, −28% шанс бегства), scout (Рейд-капитан, +1 ход, +1 обзор).

## eras.ts — эпохи
- `ERA_IDS`, `isEraId`, `eraOf(settings)` `:16-24`.
- `ERAS` `:55` — тексты интерфейса эпохи (подсказки, названия «Залп»/«Набег» и т.п.).
- `MEDIEVAL_UNITS` `:119`, `NAPOLEONIC_UNITS` `:209` — переименования и правки статов (в наполеонике лучники → мушкеты/батареи, есть артиллерия).
- `ERA_BUILDINGS` `:333`, `ERA_COMMANDERS` `:355`, `ERA_TECHS` `:371` + `buildingsFor/commandersFor/techsFor` `:387-412`.

## config.ts — баланс
`MAX_PLAYERS=4`, `MIN_PLAYERS=2`, `MAX_ROUNDS=30`, `MAP_SIZES`, `ROUND_OPTIONS`, `ACTION_OPTIONS`, размеры гекса `:12-15`,
`BASE_ACTIONS=5`, `START_RESOURCES`, `CAPITAL_START_ARMY=6`, `CAPITAL_INCOME`, `ECONOMY_TECH_BONUS=0.15`, `STARVATION_DESERTION=0.15`,
`TERRAIN` `:46`, `BUILDINGS` `:66` (farm, mine, market, palisade, fort, barracks), `TECHS` `:136`, `techCost` `:143`,
`defaultGameSettings` `:141`, `PLAYER_COLORS` `:157`.

## map.ts — гекс-сетка
- Координаты odd-r (нечётный ряд сдвинут вправо), внутри — кубические. `hexLine` `:40`, `hexNeighborCoords` `:57`,
  `tileIndex/tileAt` `:62-70`, `neighbors` `:71`, `hexDistance` `:80`, `isAdjacent` `:88`.
- `chargePathOpen` `:96`, `walkPath` `:115` (путь с учётом стоимости местности), `walkReachable` `:165`.
- Пиксели: `hexBoardSize` `:193`, `hexTileBox` `:201`.
- Генерация: `rollTerrain` `:210`, `smooth` `:224`, `blankTiles` `:267`, `resizeTiles` `:277`,
  `ensureCapitalApproaches` `:289`, `mapSizeFor` `:315`, `capitalSpots` `:320`, `generateTiles` `:332`.

## vision.ts — туман войны
- `VISION_BASE=3` `:7`, `observerRange` `:16` (+холмы/скаут), `visionObservers` `:24` (войска, столица, крепость).
- `hasLineOfSight` `:33` — горы закрывают, холм закрывает если не ниже наблюдателя, два леса подряд глушат.
- `canWatchTile` `:57`, `canDetectArmyOn` `:77`, `canSeeArmyOn` `:86` (лес — только вплотную).
- `rememberSeenBuildings` `:110`, `maskTile` `:122`, **`maskStateFor`** `:140` (копия без чужих войск/неувиденных
  построек; заодно обнуляет `resources` всех игроков, кроме зрителя — иначе экономика соперника видна даже
  под туманом), `publicView` `:159` (сверху `maskStateFor` ещё скрывает `state.seed`, пока партия не `finished` —
  от seed детерминированно зависят все будущие броски боя; используется сервером в `viewOf` вместо голого
  `maskStateFor`), `maskFxFor` `:164` (скрывает анимацию, если её не видно).

## rng.ts
`mulberry32(seed)`, `randomSeed()`, `randomRoomCode()` (5 символов без 0/O/1/I).

## Новое (план функций 2026-09-29)

- `log(state, text, {actors, at, focus, public})` — запись журнала с `seenBy`; `maskStateFor` фильтрует журнал, скрывает чужие `tech`, `stats`, `effects`, `event`, историю и рекорды (до конца партии).
- `normalizeState` — дефолты для сохранений старого формата; новые поля всегда с дефолтом.
- Статистика: `Player.stats`, `state.history` (срез на конец раунда и в `finish`), `state.records`; `rankPlayers`.
- `events.ts` — таблица 24 событий и `pickEvent`; применение — `applyEventEffect`/`rollEvent`/`startEvent` в engine (бросок в конце `beginTurn`, с 3-го раунда, 25 %, пауза 2 хода, без повторов 5 раундов). Выбор — действие `eventChoice`; без ответа к концу хода — вариант 0. Эффекты: `Player.effects` (`computeIncome`, `attackMultiplier`, `techCostFor`).
- `diplomacy.ts` + engine: `relations`, `proposals`, действия `propose/acceptProposal/declineProposal/breakTreaty` (без ⚡, не только в свой ход). Перемирие/союз блокируют вход на земли, залп и путь (`map.ts shielded`); союз — общий обзор (`vision.ts isFriend`), проход набега через союзную клетку; разрыв — `breakAt` = раунд+1, вступает с хода разорвавшего; все живые в союзе → общая победа.
- ИИ: `ai.ts` — `planAiTurn` (варианты по убыванию ценности, пороги в `TUNING`), `planAiDiplomacy`, `aiSquareReply`, `stepAi`. Игроки `ai:<n>`, лобби-действия `addAi/removeAi`.
