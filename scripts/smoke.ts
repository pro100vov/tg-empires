/**
 * Прогон правил без интерфейса: проверяет экономику, лимит действий, бой,
 * падение державы при потере столицы и голод. Запуск: npm run smoke
 */
import assert from 'node:assert/strict';
import {
  BASE_ACTIONS,
  HEX_COL_STEP,
  HEX_ROW_STEP,
  MAP_SIZE,
  TERRAIN,
  addPlayer,
  applyAction,
  applyLobbyAction,
  actingPlayerId,
  armyCount,
  armyPower,
  armySpeed,
  armyCanCharge,
  armyCanKite,
  mixWarning,
  allyStacksCovering,
  enterHaltsArmy,
  enterMoveCost,
  autoEndTurnIfExhausted,
  battleForecastRatio,
  chargePathOpen,
  canSeeArmyOn,
  canDetectArmyOn,
  canWatchTile,
  maskFxFor,
  BUILDINGS,
  buildingsFor,
  commandersFor,
  techsFor,
  unitsFor,
  unitRange,
  armyRange,
  unitShotKind,
  archerArmy,
  isEraId,
  computeIncome,
  defenseMultiplier,
  createGame,
  currentPlayer,
  startGame,
  setupHotseat,
  isLobbyAdmin,
  hasLineOfSight,
  hexDistance,
  hexLine,
  hexNeighborCoords,
  hexTileBox,
  isAdjacent,
  maskStateFor,
  rememberSeenBuildings,
  neighbors,
  tileAt,
  walkPath,
  upkeepFor,
  ensureWings,
  writeWings,
  VISION_BASE,
  parseGameAction,
  parseLobbyAction,
  publicView,
  markDisconnected,
  removePlayer,
} from '../shared/src/index.js';
import type { GameState, Tile } from '../shared/src/index.js';

function capitalOf(state: GameState, playerId: string): Tile {
  const tile = state.tiles.find((t) => t.capitalOf === playerId);
  assert.ok(tile, `у игрока ${playerId} нет столицы`);
  return tile;
}

function newGame(): GameState {
  const state = createGame('TEST1', 'p1', 12345);
  addPlayer(state, 'p1', 'Первый');
  addPlayer(state, 'p2', 'Второй');
  const started = startGame(state, 'p1');
  assert.ok(started.ok, 'игра должна стартовать');
  return state;
}

function checkStart(): void {
  const state = newGame();
  assert.equal(state.phase, 'playing');
  assert.equal(state.players.length, 2);
  for (const player of state.players) {
    const capital = capitalOf(state, player.id);
    assert.equal(armyCount(capital.army), 6, 'в столице стартовый гарнизон');
    assert.equal(capital.army.medium_infantry, 6, 'старт — средняя пехота');
    assert.ok(capital.ownerId === player.id);
    assert.equal(capital.building, 'fort', 'в столице сразу стоит крепость');
    const income = computeIncome(state, player.id);
    assert.ok(income.gold > 0 && income.food > 0, 'столица приносит доход');
  }
  assert.equal(state.width, MAP_SIZE);
  assert.equal(state.height, MAP_SIZE);
  assert.equal(state.tiles.length, MAP_SIZE * MAP_SIZE);
  assert.equal(currentPlayer(state)!.actionsLeft, BASE_ACTIONS, 'пять действий в начале хода');
  console.log('✓ старт партии, столицы и доход');
}

function checkActionLimit(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);

  for (let i = 0; i < BASE_ACTIONS; i++) {
    const result = applyAction(state, me.id, { type: 'recruit', at: capital, count: 1, unit: 'medium_infantry' });
    assert.ok(result.ok, `найм №${i + 1} должен пройти`);
    autoEndTurnIfExhausted(state);
  }
  assert.notEqual(currentPlayer(state)!.id, me.id, 'после пяти действий ход уходит сопернику');

  const late = applyAction(state, me.id, { type: 'recruit', at: capital, count: 1 });
  assert.equal(late.ok, false, 'чужой ход — действие отклонено');
  console.log('✓ лимит действий и переход хода');
}

/**
 * move не тратит действие, если отряд уже в походе (wingsAlreadyMarching). Раньше
 * autoEndTurnIfExhausted мог завершить ход сразу при 0 действий, не дав продолжить такой
 * поход бесплатно. Теперь, пока есть клетка с «крылом» в пути, автоконец хода откладывается.
 */
function checkNoAutoEndDuringFreeMarch(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);
  capital.army = { light_cavalry: 5 };
  writeWings(capital, [{ army: { light_cavalry: 5 }, movesLeft: 1, shotsLeft: 1 }]);
  me.actionsLeft = 0;

  autoEndTurnIfExhausted(state);
  assert.equal(currentPlayer(state)!.id, me.id, 'ход не завершается, пока поход можно продолжить бесплатно');

  const dest = neighbors(state, capital).find((t) => TERRAIN[t.terrain].passable && armyCount(t.army) === 0);
  assert.ok(dest, 'нужна свободная соседняя клетка для завершения похода');
  dest.terrain = 'plains';
  const move = applyAction(state, me.id, {
    type: 'move',
    from: { x: capital.x, y: capital.y },
    to: { x: dest.x, y: dest.y },
    count: 5,
  });
  assert.ok(move.ok, 'бесплатное продолжение похода проходит');
  assert.equal(me.actionsLeft, 0, 'бесплатное продолжение похода не тратит действие');
  assert.equal(dest.movesLeft, 0, 'ход полностью исчерпан после продолжения');

  autoEndTurnIfExhausted(state);
  assert.notEqual(currentPlayer(state)!.id, me.id, 'когда поход исчерпан, ход завершается автоматически');
  console.log('✓ автоконец хода ждёт бесплатное продолжение похода, пока оно возможно');
}

function checkBattleAndElimination(): void {
  const state = newGame();
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const enemyCapital = capitalOf(state, defender.id);

  // Ставим подавляющие силы вплотную к вражеской столице.
  const staging = tileAt(state, enemyCapital.x - 1, enemyCapital.y) ?? tileAt(state, enemyCapital.x + 1, enemyCapital.y);
  assert.ok(staging, 'рядом со столицей должна быть клетка');
  staging.ownerId = attacker.id;
  staging.terrain = 'plains';
  staging.army = { heavy_cavalry: 200 };
  staging.movesLeft = 2;

  const result = applyAction(state, attacker.id, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: enemyCapital.x, y: enemyCapital.y },
    count: 200,
  });

  assert.ok(result.ok, 'атака должна выполниться');
  assert.equal(result.ok && result.fx?.battle, 'won', 'победа даёт боевой эффект');
  assert.equal(result.ok && result.fx?.unit, 'heavy_cavalry');
  assert.equal(enemyCapital.ownerId, attacker.id, 'столица переходит победителю');
  assert.equal(state.players.find((p) => p.id === defender.id)!.alive, false, 'держава пала');
  assert.equal(state.phase, 'finished', 'партия завершается');
  assert.equal(state.winnerId, attacker.id, 'победитель определён');
  console.log('✓ бой, захват столицы и завершение партии');
}

function checkFailedAttack(): void {
  const state = newGame();
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const enemyCapital = capitalOf(state, defender.id);

  const staging = tileAt(state, enemyCapital.x - 1, enemyCapital.y) ?? tileAt(state, enemyCapital.x + 1, enemyCapital.y);
  assert.ok(staging);
  staging.ownerId = attacker.id;
  staging.terrain = 'plains';
  staging.army = { light_infantry: 1 };
  staging.movesLeft = 1;

  const result = applyAction(state, attacker.id, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: enemyCapital.x, y: enemyCapital.y },
    count: 1,
  });

  assert.equal(enemyCapital.ownerId, defender.id, 'слабая атака не берёт столицу');
  assert.ok(armyCount(staging.army) >= 1 || armyCount(enemyCapital.army) >= 1, 'у обороны остаются войска');
  // слабая атака из 1 отряда может погибнуть целиком — это ок
  assert.equal(result.ok && (result.fx?.battle === 'lost' || result.fx?.battle === 'rout'), true, 'отбитая атака даёт эффект проигрыша');
  assert.equal(staging.movesLeft, 0, 'отбитая атака тоже заканчивает ход стека');
  assert.equal(state.phase, 'playing');
  console.log('✓ заведомо слабая атака отбита');
}

function checkJointAttack(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const foe = state.players.find((p) => p.id !== me.id)!;
  const target = state.tiles.find((t) => {
    if (t.capitalOf) return false;
    if (!TERRAIN[t.terrain].passable) return false;
    return neighbors(state, t).filter((n) => TERRAIN[n.terrain].passable && !n.capitalOf).length >= 2;
  });
  assert.ok(target);
  target.terrain = 'plains';
  target.ownerId = foe.id;
  target.army = { medium_infantry: 8 };
  const around = neighbors(state, target).filter((n) => TERRAIN[n.terrain].passable && !n.capitalOf);
  const striker = around[0]!;
  const ally = around[1]!;
  striker.terrain = 'plains';
  striker.ownerId = me.id;
  striker.army = { light_infantry: 1 };
  striker.movesLeft = 1;
  ally.terrain = 'plains';
  ally.ownerId = me.id;
  ally.army = { heavy_cavalry: 40 };
  ally.movesLeft = 1;
  assert.equal(allyStacksCovering(state, me.id, target, striker).length, 1);

  const result = applyAction(state, me.id, {
    type: 'move',
    from: { x: striker.x, y: striker.y },
    to: { x: target.x, y: target.y },
    count: 1,
    supportFrom: [{ x: ally.x, y: ally.y }],
  });
  assert.ok(result.ok);
  assert.equal(result.ok && result.fx?.battle, 'won', 'два отряда вместе берут цель, которую один не взял бы');
  assert.equal(target.ownerId, me.id, 'атакующий занимает клетку');
  assert.ok(armyCount(target.army) >= 1, 'на захваченной клетке остаётся ударный отряд');
  assert.equal(ally.ownerId, me.id, 'второй отряд остаётся на своей клетке');
  assert.ok(armyCount(ally.army) > 0, 'второй отряд не телепортируется');
  assert.equal(ally.movesLeft, 0, 'помощник после совместного удара больше не ходит');
  assert.equal(ally.shotsLeft, 0, 'помощник после совместного удара не стреляет');
  console.log('✓ совместный удар двух отрядов');
}

function checkStarvation(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);

  capital.army = { medium_infantry: 100 };
  me.resources.food = 0;
  const upkeep = upkeepFor(state, me.id);
  assert.equal(upkeep, 120, 'средняя пехота ест 1.2 еды за отряд');
  capital.army = { heavy_cavalry: 10, light_infantry: 10 };
  assert.equal(upkeepFor(state, me.id), 40, 'конница ест больше пехоты');
  capital.army = { medium_infantry: 100 };

  // Прокручиваем круг, чтобы у игрока начался новый ход с недостатком еды.
  applyAction(state, me.id, { type: 'endTurn' });
  const other = currentPlayer(state)!;
  applyAction(state, other.id, { type: 'endTurn' });

  assert.equal(currentPlayer(state)!.id, me.id);
  assert.ok(armyCount(capital.army) < 100, 'без еды часть войск дезертирует');
  console.log('✓ содержание армии и дезертирство при голоде');
}

function checkUnitRoster(): void {
  const vsCav = armyPower({ medium_infantry: 10 }, 'attack', 'cavalry', 'plains');
  const vsArc = armyPower({ medium_infantry: 10 }, 'attack', 'archer', 'plains');
  assert.ok(vsCav > vsArc, 'пехота сильнее против конницы, чем против лучников');

  const infForest = armyPower({ medium_infantry: 10 }, 'attack', 'cavalry', 'forest');
  const infPlains = armyPower({ medium_infantry: 10 }, 'attack', 'cavalry', 'plains');
  assert.ok(infForest / infPlains > 0.93, 'пехота бьёт в лес почти без штрафа');
  assert.ok(infForest < infPlains, 'крошечный штраф пехоте в чаще всё же есть');

  const lightForest = armyPower({ light_infantry: 10 }, 'attack', 'cavalry', 'forest');
  const lightPlains = armyPower({ light_infantry: 10 }, 'attack', 'cavalry', 'plains');
  const heavyForest = armyPower({ heavy_infantry: 10 }, 'attack', 'cavalry', 'forest');
  const heavyPlains = armyPower({ heavy_infantry: 10 }, 'attack', 'cavalry', 'plains');
  assert.ok(lightForest > lightPlains, 'лёгкая пехота в лесу как дома');
  assert.ok(heavyForest / heavyPlains < 0.9, 'тяжёлая пехота в чаще теряет строй');

  const cavForest = armyPower({ medium_cavalry: 10 }, 'attack', 'archer', 'forest');
  const cavHills = armyPower({ medium_cavalry: 10 }, 'attack', 'archer', 'hills');
  const cavPlains = armyPower({ medium_cavalry: 10 }, 'attack', 'archer', 'plains');
  assert.ok(cavForest / cavPlains < 0.7, 'конница в лесу сильно слабее');
  assert.ok(cavHills < cavPlains, 'конница слабее на холмах');
  assert.ok(cavForest < cavHills, 'лес для коней хуже холмов');

  const volleyPlains = armyPower({ medium_archer: 10 }, 'attack', 'infantry', 'plains', {
    volley: true,
    fromTerrain: 'plains',
  });
  const volleyForest = armyPower({ medium_archer: 10 }, 'attack', 'infantry', 'forest', {
    volley: true,
    fromTerrain: 'plains',
  });
  const volleyHills = armyPower({ medium_archer: 10 }, 'attack', 'infantry', 'hills', {
    volley: true,
    fromTerrain: 'plains',
  });
  const volleyFromHills = armyPower({ medium_archer: 10 }, 'attack', 'infantry', 'plains', {
    volley: true,
    fromTerrain: 'hills',
  });
  assert.ok(volleyForest / volleyPlains < 0.55, 'залп в лес с большим штрафом');
  assert.ok(volleyHills < volleyPlains, 'залп в холм слабее, чем по равнине');
  assert.ok(volleyFromHills > volleyPlains, 'залп с холмов сильнее');

  const horseForest = armyPower({ medium_horse_archer: 10 }, 'attack', 'infantry', 'forest', {
    volley: true,
    fromTerrain: 'plains',
  });
  const horsePlains = armyPower({ medium_horse_archer: 10 }, 'attack', 'infantry', 'plains', {
    volley: true,
    fromTerrain: 'plains',
  });
  assert.ok(horseForest / horsePlains < volleyForest / volleyPlains, 'конные лучники в чащу бьют ещё слабее');

  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);
  me.resources.gold = 200;
  me.resources.iron = 200;
  const hired = applyAction(state, me.id, { type: 'recruit', at: capital, count: 2, unit: 'light_cavalry' });
  assert.ok(hired.ok, 'найм конницы должен пройти');
  assert.equal(capital.army.light_cavalry, 2);
  assert.equal(capital.army.medium_infantry, 6);
  const hiredHorse = applyAction(state, me.id, { type: 'recruit', at: capital, count: 1, unit: 'medium_horse_archer' });
  assert.ok(hiredHorse.ok, 'найм конных лучников');
  assert.equal(capital.army.medium_horse_archer, 1);
  assert.equal(armySpeed({ medium_horse_archer: 2 }), 3, 'конные лучники ходят на 3');
  assert.ok(mixWarning({ medium_infantry: 6 }, { light_horse_archer: 1 })?.includes('залпа'));
  assert.ok(mixWarning({ medium_cavalry: 3 }, { medium_infantry: 2 })?.includes('набег'));
  console.log('✓ двенадцать родов войск, камень-ножницы-бумага и найм');
}

function checkFreshRecruitCanMove(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);
  const next = neighbors(state, capital).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(next);
  assert.ok(
    applyAction(state, me.id, {
      type: 'move',
      from: capital,
      to: next,
      count: armyCount(capital.army),
    }).ok,
  );
  assert.equal(armyCount(capital.army), 0);
  me.resources.gold = 80;
  me.resources.iron = 40;
  const hired = applyAction(state, me.id, { type: 'recruit', at: capital, count: 1, unit: 'medium_horse_archer' });
  assert.ok(hired.ok);
  assert.equal(capital.movesLeft, 3, 'наём на пустую столицу сразу даёт запас хода');
  const step = neighbors(state, capital).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === next.x && t.y === next.y),
  );
  assert.ok(step);
  const marched = applyAction(state, me.id, {
    type: 'move',
    from: capital,
    to: step,
    count: 1,
  });
  assert.ok(marched.ok, 'только что нанятые конные лучники могут идти в тот же ход');
  console.log('✓ свежий найм сразу ходит');
}

function checkMovementCap(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);
  const next = neighbors(state, capital).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(next);
  assert.equal(capital.movesLeft, 1, 'пехота ходит на 1 гекс за ход');

  const first = applyAction(state, me.id, {
    type: 'move',
    from: { x: capital.x, y: capital.y },
    to: { x: next.x, y: next.y },
    count: armyCount(capital.army),
  });
  assert.ok(first.ok, 'первый шаг пехоты должен пройти');
  assert.equal(next.movesLeft, 0);

  const again = neighbors(state, next).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === capital.x && t.y === capital.y),
  );
  assert.ok(again);
  const second = applyAction(state, me.id, {
    type: 'move',
    from: { x: next.x, y: next.y },
    to: { x: again.x, y: again.y },
    count: armyCount(next.army),
  });
  assert.equal(second.ok, false, 'пехота не проходит 2 гекса за ход');

  const cavGame = newGame();
  const rider = currentPlayer(cavGame)!;
  const home = capitalOf(cavGame, rider.id);
  const step1 = neighbors(cavGame, home).find((t) => TERRAIN[t.terrain].passable)!;
  step1.terrain = 'plains';
  home.army = { medium_cavalry: 4 };
  home.movesLeft = 2;
  const energyBefore = rider.actionsLeft;
  assert.ok(
    applyAction(cavGame, rider.id, {
      type: 'move',
      from: home,
      to: step1,
      count: 4,
    }).ok,
  );
  assert.equal(step1.movesLeft, 1);
  assert.equal(rider.actionsLeft, energyBefore - 1, 'первый шаг конницы тратит 1 энергию');
  const step2 = neighbors(cavGame, step1).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === home.x && t.y === home.y),
  )!;
  step2.terrain = 'plains';
  assert.ok(
    applyAction(cavGame, rider.id, {
      type: 'move',
      from: step1,
      to: step2,
      count: 4,
    }).ok,
    'конница проходит второй гекс',
  );
  assert.equal(step2.movesLeft, 0);
  assert.equal(rider.actionsLeft, energyBefore - 1, 'второй гекс того же хода не тратит энергию');

  const leapGame = newGame();
  const leaper = currentPlayer(leapGame)!;
  const leapHome = capitalOf(leapGame, leaper.id);
  leapHome.army = { medium_cavalry: 3 };
  leapHome.movesLeft = 2;
  const far = leapGame.tiles.find((t) => {
    if (!TERRAIN[t.terrain].passable) return false;
    const path = walkPath(leapGame, leapHome, t, leaper.id, 2, false);
    return path != null && path.length === 3;
  });
  assert.ok(far, 'нужна клетка в двух гексах хода');
  const leapEnergy = leaper.actionsLeft;
  assert.equal(
    applyAction(leapGame, leaper.id, {
      type: 'move',
      from: leapHome,
      to: far,
      count: 3,
    }).ok,
    false,
    'конница не перепрыгивает 2 пустых гекса одним ходом',
  );
  assert.equal(leapHome.army.medium_cavalry, 3);
  assert.equal(leaper.actionsLeft, leapEnergy, 'отклонённый прыжок не тратит энергию');

  const bowGame = newGame();
  const bowman = currentPlayer(bowGame)!;
  const bowHome = capitalOf(bowGame, bowman.id);
  const bow1 = neighbors(bowGame, bowHome).find((t) => TERRAIN[t.terrain].passable)!;
  bow1.terrain = 'plains';
  bowHome.army = { light_archer: 4 };
  bowHome.movesLeft = 2;
  assert.ok(
    applyAction(bowGame, bowman.id, {
      type: 'move',
      from: bowHome,
      to: bow1,
      count: 4,
    }).ok,
  );
  assert.equal(bow1.movesLeft, 1);
  const bow2 = neighbors(bowGame, bow1).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === bowHome.x && t.y === bowHome.y),
  )!;
  bow2.terrain = 'plains';
  assert.ok(
    applyAction(bowGame, bowman.id, {
      type: 'move',
      from: bow1,
      to: bow2,
      count: 4,
    }).ok,
    'лёгкие лучники проходят второй гекс',
  );
  assert.equal(bow2.movesLeft, 0);

  const haGame = newGame();
  const ha = currentPlayer(haGame)!;
  const haHome = capitalOf(haGame, ha.id);
  haHome.army = { medium_horse_archer: 3 };
  haHome.movesLeft = 3;
  let from = haHome;
  for (let i = 0; i < 3; i++) {
    const step = neighbors(haGame, from).find(
      (t) =>
        TERRAIN[t.terrain].passable &&
        armyCount(t.army) === 0 &&
        !(t.x === haHome.x && t.y === haHome.y) &&
        (t.ownerId == null || t.ownerId === ha.id),
    );
    assert.ok(step, `конным лучникам нужен шаг ${i + 1}`);
    step.terrain = 'plains';
    const moved = applyAction(haGame, ha.id, {
      type: 'move',
      from: { x: from.x, y: from.y },
      to: { x: step.x, y: step.y },
      count: 3,
    });
    assert.ok(moved.ok, `конные лучники шаг ${i + 1}`);
    assert.equal(step.movesLeft, 2 - i);
    from = step;
  }
  assert.equal(ha.actionsLeft, BASE_ACTIONS - 1, 'три гекса конных лучников — 1 энергия');

  const fightGame = newGame();
  const fighter = currentPlayer(fightGame)!;
  const foe = fightGame.players.find((p) => p.id !== fighter.id)!;
  const fightHome = capitalOf(fightGame, fighter.id);
  const fightTarget = neighbors(fightGame, fightHome).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(fightTarget);
  fightTarget.ownerId = foe.id;
  fightTarget.terrain = 'plains';
  fightTarget.army = { light_infantry: 1 };
  fightHome.army = { medium_cavalry: 20 };
  fightHome.movesLeft = 2;
  assert.ok(
    applyAction(fightGame, fighter.id, {
      type: 'move',
      from: fightHome,
      to: { x: fightTarget.x, y: fightTarget.y },
      count: 20,
    }).ok,
    'конница бьёт соседний гекс',
  );
  assert.equal(fightTarget.ownerId, fighter.id);
  assert.equal(fightTarget.movesLeft, 0, 'после ближнего боя запас хода сгорает');
  const afterFight = neighbors(fightGame, fightTarget).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === fightHome.x && t.y === fightHome.y) && armyCount(t.army) === 0,
  );
  assert.ok(afterFight);
  assert.equal(
    applyAction(fightGame, fighter.id, {
      type: 'move',
      from: { x: fightTarget.x, y: fightTarget.y },
      to: { x: afterFight.x, y: afterFight.y },
      count: armyCount(fightTarget.army),
    }).ok,
    false,
    'после атаки конница не отходит',
  );

  const seizeGame = newGame();
  const seizer = currentPlayer(seizeGame)!;
  const seizedFoe = seizeGame.players.find((p) => p.id !== seizer.id)!;
  const seizeHome = capitalOf(seizeGame, seizer.id);
  const empty = neighbors(seizeGame, seizeHome).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(empty);
  empty.ownerId = seizedFoe.id;
  empty.army = {};
  empty.terrain = 'plains';
  seizeHome.army = { medium_cavalry: 4 };
  seizeHome.movesLeft = 2;
  assert.ok(
    applyAction(seizeGame, seizer.id, {
      type: 'move',
      from: seizeHome,
      to: { x: empty.x, y: empty.y },
      count: 4,
    }).ok,
  );
  assert.equal(empty.movesLeft, 1, 'захват пустой клетки не отбирает остаток хода');
  const seizeNext = neighbors(seizeGame, empty).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === seizeHome.x && t.y === seizeHome.y) && armyCount(t.army) === 0,
  );
  assert.ok(seizeNext);
  seizeNext.terrain = 'plains';
  assert.ok(
    applyAction(seizeGame, seizer.id, {
      type: 'move',
      from: { x: empty.x, y: empty.y },
      to: { x: seizeNext.x, y: seizeNext.y },
      count: 4,
    }).ok,
    'после захвата пустого гекса можно шагнуть дальше',
  );

  assert.equal(enterMoveCost({ medium_cavalry: 2 }, 'forest'), 2);
  assert.equal(enterMoveCost({ medium_cavalry: 2 }, 'hills'), 1);
  assert.equal(enterMoveCost({ heavy_cavalry: 1 }, 'hills'), 2);
  assert.equal(enterMoveCost({ medium_infantry: 2 }, 'forest'), 1);
  assert.equal(enterHaltsArmy({ medium_cavalry: 1 }, 'hills'), false);
  assert.equal(enterHaltsArmy({ light_cavalry: 1 }, 'forest'), false);
  assert.equal(enterHaltsArmy({ light_archer: 2 }, 'forest'), false);
  assert.equal(enterHaltsArmy({ medium_horse_archer: 1 }, 'forest'), true);
  assert.equal(enterHaltsArmy({ heavy_cavalry: 1 }, 'forest'), true);

  const woodsGame = newGame();
  const woodsRider = currentPlayer(woodsGame)!;
  const woodsHome = capitalOf(woodsGame, woodsRider.id);
  const woods = neighbors(woodsGame, woodsHome).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(woods);
  woods.terrain = 'forest';
  woodsHome.army = { medium_cavalry: 4 };
  woodsHome.movesLeft = 2;
  assert.ok(
    applyAction(woodsGame, woodsRider.id, {
      type: 'move',
      from: woodsHome,
      to: { x: woods.x, y: woods.y },
      count: 4,
    }).ok,
    'конница входит в лес за 2 клетки хода',
  );
  assert.equal(woods.movesLeft, 0, 'лес останавливает сомкнутую конницу');
  const woodsNext = neighbors(woodsGame, woods).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === woodsHome.x && t.y === woodsHome.y),
  );
  assert.ok(woodsNext);
  woodsNext.terrain = 'plains';
  assert.equal(
    applyAction(woodsGame, woodsRider.id, {
      type: 'move',
      from: { x: woods.x, y: woods.y },
      to: { x: woodsNext.x, y: woodsNext.y },
      count: 4,
    }).ok,
    false,
    'из леса в тот же ход конница не идёт',
  );

  const shortGame = newGame();
  const shortRider = currentPlayer(shortGame)!;
  const shortHome = capitalOf(shortGame, shortRider.id);
  const shortWoods = neighbors(shortGame, shortHome).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(shortWoods);
  shortWoods.terrain = 'forest';
  shortHome.army = { medium_cavalry: 3 };
  shortHome.movesLeft = 1;
  assert.ok(
    applyAction(shortGame, shortRider.id, {
      type: 'move',
      from: shortHome,
      to: { x: shortWoods.x, y: shortWoods.y },
      count: 3,
    }).ok,
    'с 1 клеткой хода кони всё равно входят в лес и встают',
  );
  assert.equal(shortWoods.movesLeft, 0, 'нехватка запаса тоже останавливает');

  const hillGame = newGame();
  const hillRider = currentPlayer(hillGame)!;
  const hillHome = capitalOf(hillGame, hillRider.id);
  const hill = neighbors(hillGame, hillHome).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(hill);
  hill.terrain = 'hills';
  hillHome.army = { medium_cavalry: 4 };
  hillHome.movesLeft = 2;
  assert.ok(
    applyAction(hillGame, hillRider.id, {
      type: 'move',
      from: hillHome,
      to: { x: hill.x, y: hill.y },
      count: 4,
    }).ok,
  );
  assert.equal(hill.movesLeft, 1, 'холм не стопорит среднюю конницу');
  const hillNext = neighbors(hillGame, hill).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === hillHome.x && t.y === hillHome.y),
  );
  assert.ok(hillNext);
  hillNext.terrain = 'plains';
  assert.ok(
    applyAction(hillGame, hillRider.id, {
      type: 'move',
      from: { x: hill.x, y: hill.y },
      to: { x: hillNext.x, y: hillNext.y },
      count: 4,
    }).ok,
    'с холма средняя конница идёт дальше',
  );

  const heavyHillGame = newGame();
  const heavyHillRider = currentPlayer(heavyHillGame)!;
  const heavyHillHome = capitalOf(heavyHillGame, heavyHillRider.id);
  const heavyHill = neighbors(heavyHillGame, heavyHillHome).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(heavyHill);
  heavyHill.terrain = 'hills';
  heavyHillHome.army = { heavy_cavalry: 2 };
  heavyHillHome.movesLeft = 2;
  assert.ok(
    applyAction(heavyHillGame, heavyHillRider.id, {
      type: 'move',
      from: heavyHillHome,
      to: { x: heavyHill.x, y: heavyHill.y },
      count: 2,
    }).ok,
  );
  assert.equal(heavyHill.movesLeft, 0, 'тяжёлая конница тратит 2 кл. на холм');

  const footGame = newGame();
  const foot = currentPlayer(footGame)!;
  const footHome = capitalOf(footGame, foot.id);
  const footWoods = neighbors(footGame, footHome).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(footWoods);
  footWoods.terrain = 'forest';
  assert.ok(
    applyAction(footGame, foot.id, {
      type: 'move',
      from: footHome,
      to: { x: footWoods.x, y: footWoods.y },
      count: armyCount(footHome.army),
    }).ok,
    'пехота входит в лес за 1 клетку',
  );

  const haWoodsGame = newGame();
  const haWoods = currentPlayer(haWoodsGame)!;
  const haHome2 = capitalOf(haWoodsGame, haWoods.id);
  const haForest = neighbors(haWoodsGame, haHome2).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(haForest);
  haForest.terrain = 'forest';
  haHome2.army = { medium_horse_archer: 3 };
  haHome2.movesLeft = 3;
  assert.ok(
    applyAction(haWoodsGame, haWoods.id, {
      type: 'move',
      from: haHome2,
      to: { x: haForest.x, y: haForest.y },
      count: 3,
    }).ok,
  );
  assert.equal(haForest.movesLeft, 0, 'конные лучники в лесу тоже останавливаются');

  const lightHaGame = newGame();
  const lightHa = currentPlayer(lightHaGame)!;
  const lightHaHome = capitalOf(lightHaGame, lightHa.id);
  const lightHaForest = neighbors(lightHaGame, lightHaHome).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(lightHaForest);
  lightHaForest.terrain = 'forest';
  lightHaHome.army = { light_horse_archer: 2 };
  lightHaHome.movesLeft = 3;
  assert.ok(
    applyAction(lightHaGame, lightHa.id, {
      type: 'move',
      from: lightHaHome,
      to: { x: lightHaForest.x, y: lightHaForest.y },
      count: 2,
    }).ok,
  );
  assert.equal(lightHaForest.movesLeft, 1, 'лёгкие конные лучники пробираются через лес');

  const mixForestGame = newGame();
  const mixRider = currentPlayer(mixForestGame)!;
  const mixHome = capitalOf(mixForestGame, mixRider.id);
  const mixWoods = neighbors(mixForestGame, mixHome).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(mixWoods);
  mixWoods.terrain = 'forest';
  mixHome.army = { medium_infantry: 4, light_cavalry: 1 };
  mixHome.movesLeft = 1;
  assert.ok(
    applyAction(mixForestGame, mixRider.id, {
      type: 'move',
      from: mixHome,
      to: { x: mixWoods.x, y: mixWoods.y },
      count: 5,
    }).ok,
    'смешанный строй с запасом 1 всё равно входит в лес',
  );
  assert.equal(mixWoods.movesLeft, 0);

  console.log('✓ лимит хода: лес стопорит сомкнутых коней, холмы только замедляют тяжёлых');
}

function checkConstruction(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);
  const plot = neighbors(state, capital).find((t) => TERRAIN[t.terrain].passable && t.ownerId === me.id);
  assert.ok(plot, 'рядом со столицей должна быть своя клетка');
  me.resources.gold = 80;
  const started = applyAction(state, me.id, { type: 'build', at: plot, building: 'farm' });
  assert.ok(started.ok);
  assert.equal(plot.building, null, 'ферма не появляется сразу');
  assert.equal(plot.construction?.building, 'farm');
  assert.equal(plot.construction?.turnsLeft, 1);

  applyAction(state, me.id, { type: 'endTurn' });
  const other = currentPlayer(state)!;
  applyAction(state, other.id, { type: 'endTurn' });

  assert.equal(currentPlayer(state)!.id, me.id);
  assert.equal(plot.building, 'farm', 'ферма достраивается на следующем вашем ходе');
  assert.equal(plot.construction, null);

  const palGame = newGame();
  const builder = currentPlayer(palGame)!;
  const home = capitalOf(palGame, builder.id);
  const wall = neighbors(palGame, home).find((t) => TERRAIN[t.terrain].passable && t.ownerId === builder.id);
  assert.ok(wall);
  wall.terrain = 'plains';
  builder.resources.gold = 80;
  builder.resources.iron = 20;
  assert.ok(applyAction(palGame, builder.id, { type: 'build', at: wall, building: 'palisade' }).ok);
  assert.equal(wall.construction?.turnsLeft, 1, 'частокол строится 1 ход');
  applyAction(palGame, builder.id, { type: 'endTurn' });
  applyAction(palGame, currentPlayer(palGame)!.id, { type: 'endTurn' });
  assert.equal(wall.building, 'palisade');
  assert.equal(BUILDINGS.palisade.defenseBonus, 0.25);
  assert.equal(defenseMultiplier(palGame, { ...wall, capitalOf: null }, builder), 1.25);
  assert.equal(defenseMultiplier(palGame, { ...wall, building: null, capitalOf: null }, builder), 1);
  console.log('✓ стройка занимает ходы; частокол даёт защиту за 1 ход');
}

function checkVolley(): void {
  const state = newGame();
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const enemyCapital = capitalOf(state, defender.id);
  const staging = state.tiles.find(
    (t) => TERRAIN[t.terrain].passable && hexDistance(t, enemyCapital) === 2,
  );
  assert.ok(staging, 'нужна клетка на дальности 2');
  staging.ownerId = attacker.id;
  staging.army = { medium_archer: 20 };
  staging.movesLeft = 1;
  staging.shotsLeft = 1;
  const before = armyCount(enemyCapital.army);
  const result = applyAction(state, attacker.id, {
    type: 'shoot',
    from: { x: staging.x, y: staging.y },
    to: { x: enemyCapital.x, y: enemyCapital.y },
  });
  assert.ok(result.ok, 'залп должен пройти');
  assert.equal(result.ok && result.fx?.kind, 'shoot');
  assert.equal(enemyCapital.ownerId, defender.id, 'залп не захватывает клетку');
  assert.ok(armyCount(enemyCapital.army) < before, 'залп наносит потери');
  assert.equal(staging.movesLeft, 0, 'пешие лучники после залпа больше не ходят');
  assert.equal(staging.shotsLeft, 0, 'залп на этот ход израсходован');
  assert.equal(
    applyAction(state, attacker.id, {
      type: 'shoot',
      from: { x: staging.x, y: staging.y },
      to: { x: enemyCapital.x, y: enemyCapital.y },
    }).ok,
    false,
    'второй залп за ход нельзя',
  );
  const afterVolley = neighbors(state, staging).find(
    (t) => TERRAIN[t.terrain].passable && armyCount(t.army) === 0 && !(t.x === enemyCapital.x && t.y === enemyCapital.y),
  );
  if (afterVolley) {
    assert.equal(
      applyAction(state, attacker.id, {
        type: 'move',
        from: { x: staging.x, y: staging.y },
        to: { x: afterVolley.x, y: afterVolley.y },
        count: armyCount(staging.army),
      }).ok,
      false,
      'после залпа пешие лучники не отходят',
    );
  }

  assert.equal(armyCanKite({ medium_horse_archer: 2 }), true);
  assert.equal(armyCanKite({ light_archer: 2 }), false);
  assert.equal(armyCanKite({ medium_horse_archer: 2, medium_infantry: 1 }), false);

  const kiteGame = newGame();
  const kiter = currentPlayer(kiteGame)!;
  const kiteFoe = kiteGame.players.find((p) => p.id !== kiter.id)!;
  const kiteCap = capitalOf(kiteGame, kiteFoe.id);
  const kiteTile = kiteGame.tiles.find(
    (t) => TERRAIN[t.terrain].passable && hexDistance(t, kiteCap) === 2,
  );
  assert.ok(kiteTile, 'нужна клетка на дальности залпа');
  kiteTile.ownerId = kiter.id;
  kiteTile.army = { medium_horse_archer: 8 };
  kiteTile.movesLeft = 3;
  kiteTile.shotsLeft = 1;
  const kiteShot = applyAction(kiteGame, kiter.id, {
    type: 'shoot',
    from: { x: kiteTile.x, y: kiteTile.y },
    to: { x: kiteCap.x, y: kiteCap.y },
  });
  assert.ok(kiteShot.ok, 'залп конных лучников');
  assert.equal(kiteTile.movesLeft, 3, 'конные лучники после залпа сохраняют ход');
  assert.equal(kiteTile.shotsLeft, 0);
  assert.equal(
    applyAction(kiteGame, kiter.id, {
      type: 'shoot',
      from: { x: kiteTile.x, y: kiteTile.y },
      to: { x: kiteCap.x, y: kiteCap.y },
    }).ok,
    false,
    'конные лучники тоже стреляют один раз за ход',
  );
  const kiteStep = neighbors(kiteGame, kiteTile).find(
    (t) =>
      TERRAIN[t.terrain].passable &&
      armyCount(t.army) === 0 &&
      !(t.x === kiteCap.x && t.y === kiteCap.y),
  );
  assert.ok(kiteStep);
  kiteStep.terrain = 'plains';
  assert.ok(
    applyAction(kiteGame, kiter.id, {
      type: 'move',
      from: { x: kiteTile.x, y: kiteTile.y },
      to: { x: kiteStep.x, y: kiteStep.y },
      count: 8,
    }).ok,
    'конные лучники отходят после залпа',
  );
  assert.equal(kiteStep.movesLeft, 2);
  console.log('✓ залп лучников на 2 гекса; конные лучники могут отойти');
}

/** Уничтоженный залпом гарнизон не должен оставлять на клетке ложное «каре». */
function checkVolleyWipeClearsSquare(): void {
  const state = createGame('NAPVOLLEY', 'p1', 7);
  addPlayer(state, 'p1', 'Первый');
  addPlayer(state, 'p2', 'Второй');
  assert.ok(applyLobbyAction(state, 'p1', { type: 'configure', settings: { era: 'napoleonic', fogOfWar: false } }).ok);
  assert.ok(startGame(state, 'p1').ok);
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const cap = capitalOf(state, defender.id);
  const staging = state.tiles.find((t) => TERRAIN[t.terrain].passable && hexDistance(t, cap) === 2);
  assert.ok(staging, 'нужна клетка на дальности 2 от вражеской столицы');
  staging.ownerId = attacker.id;
  staging.terrain = 'plains';
  staging.army = { heavy_archer: 50 };
  staging.movesLeft = 1;
  staging.shotsLeft = 1;
  cap.terrain = 'plains';
  cap.army = { medium_infantry: 1 };
  cap.square = true;
  const result = applyAction(state, attacker.id, {
    type: 'shoot',
    from: { x: staging.x, y: staging.y },
    to: { x: cap.x, y: cap.y },
  });
  assert.ok(result.ok, 'залп должен пройти');
  assert.equal(armyCount(cap.army), 0, 'гарнизон уничтожен');
  assert.equal(cap.square, false, 'после уничтожения залпом ложного каре не остаётся');
  console.log('✓ уничтоженный залпом гарнизон не оставляет ложное каре');
}

function checkCasualtiesAndCommander(): void {
  const state = newGame();
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const enemyCapital = capitalOf(state, defender.id);
  const staging = tileAt(state, enemyCapital.x - 1, enemyCapital.y) ?? tileAt(state, enemyCapital.x + 1, enemyCapital.y);
  assert.ok(staging);
  staging.ownerId = attacker.id;
  staging.terrain = 'plains';
  staging.army = { medium_infantry: 8 };
  staging.movesLeft = 1;
  enemyCapital.army = { medium_infantry: 20 };
  const beforeAtk = armyCount(staging.army);

  applyAction(state, attacker.id, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: enemyCapital.x, y: enemyCapital.y },
    count: 8,
  });

  assert.equal(enemyCapital.ownerId, defender.id, '8 пехоты не берут столицу с гарнизоном');
  assert.ok(armyCount(staging.army) > 0 && armyCount(staging.army) < beforeAtk, 'атакующие не уничтожаются целиком');

  const home = newGame();
  const me = currentPlayer(home)!;
  const capital = capitalOf(home, me.id);
  me.resources.gold = 80;
  me.resources.iron = 40;
  const appointed = applyAction(home, me.id, { type: 'appoint', at: capital, commander: 'warlord' });
  assert.ok(appointed.ok, 'назначение воеводы');
  assert.equal(capital.commander, 'warlord');
  console.log('✓ частичные потери и командиры');
}

function checkCharge(): void {
  assert.equal(armySpeed({ light_archer: 3 }), 2, 'лёгкие лучники ходят на 2');
  assert.equal(armySpeed({ medium_archer: 3 }), 1, 'средние лучники ходят на 1');
  assert.equal(armySpeed({ light_cavalry: 2 }), 3, 'лёгкая конница ходит на 3');
  assert.equal(armyCanCharge({ light_cavalry: 2 }), true);
  assert.equal(armyCanCharge({ heavy_cavalry: 1 }), true);
  assert.equal(armyCanCharge({ light_archer: 4 }), false, 'лучники не набегают');
  assert.equal(armyCanCharge({ medium_horse_archer: 2 }), false, 'конные лучники не набегают');
  assert.equal(armyCanCharge({ light_cavalry: 2, medium_infantry: 1 }), false, 'смешанный стек не набегает');

  const state = newGame();
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const enemyCapital = capitalOf(state, defender.id);
  const staging = state.tiles.find(
    (t) =>
      TERRAIN[t.terrain].passable &&
      hexDistance(t, enemyCapital) === 2 &&
      chargePathOpen(state, t, enemyCapital, attacker.id),
  );
  assert.ok(staging, 'нужна клетка на дальности 2 с путём для набега');
  staging.ownerId = attacker.id;
  staging.terrain = 'plains';
  enemyCapital.terrain = 'plains';
  for (const bridge of neighbors(state, staging)) {
    if (isAdjacent(bridge, enemyCapital) && TERRAIN[bridge.terrain].passable) bridge.terrain = 'plains';
  }
  staging.army = { medium_infantry: 8 };
  staging.movesLeft = 1;
  const denied = applyAction(state, attacker.id, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: enemyCapital.x, y: enemyCapital.y },
    count: 8,
  });
  assert.equal(denied.ok, false, 'пехота не бьёт с двух гексов');

  staging.army = { medium_cavalry: 40 };
  staging.movesLeft = 2;
  const charged = applyAction(state, attacker.id, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: enemyCapital.x, y: enemyCapital.y },
    count: 40,
  });
  assert.ok(charged.ok, 'конница бьёт с набегу');
  assert.equal(charged.ok && charged.fx?.kind, 'charge');
  assert.equal(enemyCapital.ownerId, attacker.id, 'успешный набег занимает клетку');
  assert.equal(enemyCapital.movesLeft, 0, 'после набега ходить нельзя');

  const noForestCharge = newGame();
  const nfcAtk = currentPlayer(noForestCharge)!;
  const nfcDef = noForestCharge.players.find((p) => p.id !== nfcAtk.id)!;
  const nfcCap = capitalOf(noForestCharge, nfcDef.id);
  nfcCap.terrain = 'forest';
  const nfcStage = noForestCharge.tiles.find(
    (t) => TERRAIN[t.terrain].passable && hexDistance(t, nfcCap) === 2,
  );
  assert.ok(nfcStage);
  nfcStage.ownerId = nfcAtk.id;
  nfcStage.terrain = 'plains';
  nfcStage.army = { medium_cavalry: 40 };
  nfcStage.movesLeft = 2;
  assert.equal(
    applyAction(noForestCharge, nfcAtk.id, {
      type: 'move',
      from: { x: nfcStage.x, y: nfcStage.y },
      to: { x: nfcCap.x, y: nfcCap.y },
      count: 40,
    }).ok,
    false,
    'набег в лес нельзя',
  );
  console.log('✓ набег конницы на 2 гекса');
}

function checkMergeKeepsWaitingStack(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);
  const next = neighbors(state, capital).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(next);
  next.terrain = 'plains';
  next.ownerId = me.id;
  next.army = { medium_cavalry: 3 };
  next.movesLeft = 2;
  capital.army = { medium_cavalry: 3 };
  capital.movesLeft = 2;

  assert.ok(
    applyAction(state, me.id, {
      type: 'move',
      from: capital,
      to: next,
      count: 3,
    }).ok,
    'можно подойти к своему стеку',
  );
  assert.equal(armyCount(next.army), 6);
  assert.equal(next.movesLeft, 2, 'стоявшие сохраняют полный запас хода');
  const merged = ensureWings(next);
  const byMp = new Map(merged.map((wing) => [wing.movesLeft, armyCount(wing.army)]));
  assert.equal(byMp.get(2), 3, 'три конницы ещё с полным ходом');
  assert.equal(byMp.get(1), 3, 'подошедшие потратили клетку');

  const onward = neighbors(state, next).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === capital.x && t.y === capital.y),
  );
  assert.ok(onward);
  onward.terrain = 'plains';
  assert.ok(
    applyAction(state, me.id, {
      type: 'move',
      from: next,
      to: onward,
      count: armyCount(next.army),
    }).ok,
    'все шесть могут сделать шаг: у стоявших ещё есть ход',
  );
  assert.equal(armyCount(onward.army), 6);
  assert.equal(onward.movesLeft, 1, 'у свежих ещё остаётся клетка');
  const after = ensureWings(onward);
  const afterMp = new Map(after.map((wing) => [wing.movesLeft, armyCount(wing.army)]));
  assert.equal(afterMp.get(1), 3);
  assert.equal(afterMp.get(0), 3);

  const extra = neighbors(state, onward).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === next.x && t.y === next.y),
  );
  assert.ok(extra);
  extra.terrain = 'plains';
  extra.ownerId = me.id;
  assert.equal(
    applyAction(state, me.id, {
      type: 'move',
      from: onward,
      to: extra,
      count: armyCount(onward.army),
    }).ok,
    false,
    'уставшие не ходят чужим запасом',
  );
  assert.ok(
    applyAction(state, me.id, {
      type: 'move',
      from: onward,
      to: extra,
      count: 3,
    }).ok,
    'три свежих конницы ходят своим остатком',
  );
  assert.equal(armyCount(extra.army), 3);
  assert.equal(extra.movesLeft, 0);
  assert.equal(armyCount(onward.army), 3);
  assert.equal(onward.movesLeft, 0);

  const splitGame = newGame();
  const splitter = currentPlayer(splitGame)!;
  const home = capitalOf(splitGame, splitter.id);
  const step = neighbors(splitGame, home).find((t) => TERRAIN[t.terrain].passable)!;
  step.terrain = 'plains';
  home.army = { medium_infantry: 6 };
  home.movesLeft = 1;
  assert.ok(
    applyAction(splitGame, splitter.id, {
      type: 'move',
      from: home,
      to: step,
      count: 3,
    }).ok,
  );
  assert.equal(armyCount(home.army), 3);
  assert.ok(home.movesLeft >= 1, 'остаток на клетке сохраняет ход');
  const other = neighbors(splitGame, home).find(
    (t) => TERRAIN[t.terrain].passable && !(t.x === step.x && t.y === step.y),
  );
  assert.ok(other);
  other.terrain = 'plains';
  assert.ok(
    applyAction(splitGame, splitter.id, {
      type: 'move',
      from: home,
      to: other,
      count: 3,
    }).ok,
    'второй отряд с той же клетки тоже ходит',
  );
  console.log('✓ слияние сохраняет разный запас хода; остаток на клетке тоже ходит');
}

function checkMixedStackSplit(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);
  const next = neighbors(state, capital).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(next);
  next.terrain = 'plains';
  capital.army = { medium_infantry: 4, light_horse_archer: 2 };
  capital.movesLeft = 1;
  assert.ok(
    applyAction(state, me.id, {
      type: 'move',
      from: capital,
      to: next,
      count: 2,
      unit: 'light_horse_archer',
    }).ok,
    'из смешанного стека можно вывести только конных лучников',
  );
  assert.equal(next.army.light_horse_archer, 2);
  assert.equal(next.army.medium_infantry, undefined);
  assert.equal(capital.army.medium_infantry, 4);
  assert.equal(capital.army.light_horse_archer, undefined);
  console.log('✓ из смешанного стека выводится выбранный род войск');
}

function checkForestMoveFxHidden(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const enemy = state.players.find((p) => p.id !== me.id)!;
  const myCap = capitalOf(state, me.id);
  const woods = tileAt(state, 4, 5)!;
  const dest = tileAt(state, 5, 5)!;
  woods.terrain = 'forest';
  woods.ownerId = enemy.id;
  woods.army = { medium_infantry: 4 };
  dest.terrain = 'forest';
  dest.ownerId = enemy.id;
  dest.army = {};
  assert.ok(hexDistance(woods, myCap) > 1, 'лес не в упор к столице');
  assert.equal(canDetectArmyOn(state, me.id, woods), false, 'лес вдали скрывает армию');
  assert.equal(canDetectArmyOn(state, me.id, dest), false);
  const hidden = maskFxFor(state, me.id, {
    kind: 'move',
    from: { x: woods.x, y: woods.y },
    to: { x: dest.x, y: dest.y },
    unit: 'medium_infantry',
    count: 4,
    battle: 'none',
  });
  assert.equal(hidden, undefined, 'шаг в лесу не светит анимацией');

  const near = neighbors(state, myCap).find((t) => TERRAIN[t.terrain].passable)!;
  near.terrain = 'forest';
  near.ownerId = enemy.id;
  near.army = { medium_infantry: 2 };
  assert.equal(canDetectArmyOn(state, me.id, near), true, 'лес в упор виден');
  const shown = maskFxFor(state, me.id, {
    kind: 'move',
    from: { x: woods.x, y: woods.y },
    to: { x: near.x, y: near.y },
    unit: 'medium_infantry',
    count: 2,
    battle: 'none',
  });
  assert.ok(shown, 'выход из леса в упор всё ещё виден');
  console.log('✓ шаг в дальнем лесу скрыт туманом');
}

function checkVision(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const enemy = state.players.find((p) => p.id !== me.id)!;
  const myCap = capitalOf(state, me.id);
  const theirCap = capitalOf(state, enemy.id);
  assert.ok(hexDistance(myCap, theirCap) > VISION_BASE, 'столицы далеко друг от друга');
  assert.equal(canSeeArmyOn(state, me.id, theirCap), false, 'дальняя армия скрыта');

  const masked = maskStateFor(state, me.id);
  const maskedTheirs = tileAt(masked, theirCap.x, theirCap.y)!;
  const maskedMine = tileAt(masked, myCap.x, myCap.y)!;
  assert.equal(armyCount(maskedTheirs.army), 0, 'в маске нет чужого гарнизона');
  assert.equal(maskedTheirs.ownerId, null, 'чужая земля в тумане без владельца');
  assert.equal(maskedTheirs.capitalOf, null, 'чужая столица в тумане скрыта');
  assert.ok(armyCount(theirCap.army) > 0, 'оригинал не портят');
  assert.ok(armyCount(maskedMine.army) > 0, 'свои войска видны');
  assert.equal(maskedMine.capitalOf, me.id, 'своя столица видна');

  const near = neighbors(state, myCap).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(near);
  near.ownerId = enemy.id;
  near.army = { medium_infantry: 4 };
  assert.equal(canSeeArmyOn(state, me.id, near), true, 'контакт в упор виден');

  const forest = state.tiles.find(
    (t) => t.terrain === 'forest' && hexDistance(t, myCap) === 2 && hasLineOfSight(state, myCap, t),
  );
  if (forest) {
    forest.ownerId = enemy.id;
    forest.army = { medium_infantry: 3 };
    assert.equal(canSeeArmyOn(state, me.id, forest), false, 'лес на 2 гекса скрывает армию');
  }

  const far = state.tiles.find((t) => hexDistance(t, myCap) === 2 && TERRAIN[t.terrain].passable && t !== near);
  assert.ok(far);
  const line = hexLine(myCap, far);
  assert.equal(line.length, 3);
  const mid = tileAt(state, line[1]!.x, line[1]!.y);
  assert.ok(mid);
  mid.terrain = 'mountains';
  far.ownerId = enemy.id;
  far.army = { medium_infantry: 5 };
  far.terrain = 'plains';
  assert.equal(hasLineOfSight(state, myCap, far), false, 'гора на прямой закрывает обзор');
  assert.equal(canSeeArmyOn(state, me.id, far), false, 'за горой войска не видны');

  const belt = state.tiles.find((t) => hexDistance(t, myCap) === 3);
  assert.ok(belt);
  const beltLine = hexLine(myCap, belt);
  assert.equal(beltLine.length, 4);
  const woods1 = tileAt(state, beltLine[1]!.x, beltLine[1]!.y)!;
  const woods2 = tileAt(state, beltLine[2]!.x, beltLine[2]!.y)!;
  myCap.terrain = 'plains';
  woods1.terrain = 'forest';
  woods2.terrain = 'forest';
  belt.terrain = 'plains';
  belt.ownerId = enemy.id;
  belt.army = { medium_infantry: 4 };
  assert.equal(hasLineOfSight(state, myCap, belt), false, 'два леса подряд закрывают обзор');
  assert.equal(canWatchTile(state, me.id, belt), false, 'за двумя лесами клетка в тумане');
  assert.equal(canSeeArmyOn(state, me.id, belt), false, 'за двумя лесами армии не видно');
  woods2.terrain = 'plains';
  assert.equal(hasLineOfSight(state, myCap, belt), true, 'один лес луч не глушит');

  // Ресурсы соперника не должны утекать клиенту даже там, где армия видна.
  enemy.resources = { gold: 111, food: 22, iron: 33 };
  me.resources = { gold: 5, food: 6, iron: 7 };
  const maskedRes = maskStateFor(state, me.id);
  const maskedEnemy = maskedRes.players.find((p) => p.id === enemy.id)!;
  const maskedMe = maskedRes.players.find((p) => p.id === me.id)!;
  assert.deepEqual(maskedEnemy.resources, { gold: 0, food: 0, iron: 0 }, 'чужие ресурсы обнулены в маске');
  assert.deepEqual(maskedMe.resources, { gold: 5, food: 6, iron: 7 }, 'свои ресурсы видны в маске');

  // seed виден клиенту только после конца партии — иначе все броски боя предсказуемы заранее.
  state.seed = 999;
  assert.equal(publicView(state, me.id).seed, 0, 'seed скрыт, пока партия идёт');
  state.phase = 'finished';
  assert.equal(publicView(state, me.id).seed, 999, 'seed открывается после конца партии');
  state.phase = 'playing';

  console.log('✓ туман войны: даль, лес и горы');
}

function checkBuildingMemory(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const enemy = state.players.find((p) => p.id !== me.id)!;
  const theirCap = capitalOf(state, enemy.id);
  theirCap.building = 'farm';
  rememberSeenBuildings(state, me.id);
  const hidden = maskStateFor(state, me.id);
  assert.equal(tileAt(hidden, theirCap.x, theirCap.y)!.building, null, 'далёкая ферма скрыта');

  const scout = neighbors(state, theirCap).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(scout);
  scout.ownerId = me.id;
  scout.army = { medium_infantry: 2 };
  rememberSeenBuildings(state, me.id);
  assert.equal(me.seenBuildings[`${theirCap.x},${theirCap.y}`], 'farm');

  scout.army = {};
  scout.ownerId = null;
  const remembered = maskStateFor(state, me.id);
  const rememberedCap = tileAt(remembered, theirCap.x, theirCap.y)!;
  assert.equal(rememberedCap.building, 'farm', 'увиденная постройка остаётся в памяти');
  assert.equal(rememberedCap.capitalOf, null, 'память постройки не выдаёт столицу');
  console.log('✓ память построек');
}

function checkHexGrid(): void {
  const state = newGame();
  assert.equal(state.width, 10);
  assert.equal(state.height, 10);

  const interior = tileAt(state, 4, 4);
  assert.ok(interior);
  assert.equal(neighbors(state, interior).length, 6, 'внутренний гекс имеет 6 соседей');

  const corner = tileAt(state, 0, 0)!;
  assert.equal(neighbors(state, corner).length, 2, 'угловой гекс (0;0) касается двух клеток');

  for (const n of neighbors(state, interior)) {
    assert.equal(isAdjacent(interior, n), true);
    assert.equal(isAdjacent(n, interior), true, 'смежность симметрична');
  }

  assert.equal(isAdjacent({ x: 0, y: 0 }, { x: 1, y: 1 }), false, 'диагональ квадрата — не сосед на гексе');
  assert.ok(
    hexNeighborCoords({ x: 0, y: 0 }).some((c) => c.x === 1 && c.y === 0),
    'восток от начала ряда — сосед',
  );
  assert.equal(hexTileBox(1, 0).left - hexTileBox(0, 0).left, HEX_COL_STEP, 'соседи по ряду стыкуются по вертикальному ребру');
  assert.equal(hexTileBox(0, 1).left - hexTileBox(0, 0).left, HEX_COL_STEP / 2, 'нечётный ряд сдвинут на полгекса');
  assert.equal(hexTileBox(0, 1).top - hexTileBox(0, 0).top, HEX_ROW_STEP, 'ряды стыкуются по диагональному ребру');
  console.log('✓ гексагональная сетка и шесть соседей');
}

function checkLobbySettings(): void {
  const state = createGame('ROOM1', 'p1', 777);
  addPlayer(state, 'p1', 'Хост');
  addPlayer(state, 'p2', 'Гость');
  assert.equal(state.phase, 'lobby');
  assert.equal(state.width, MAP_SIZE);
  assert.equal(state.tiles.length, MAP_SIZE * MAP_SIZE);
  assert.equal(state.settings.fogOfWar, true);
  assert.equal(state.settings.era, 'ancient');
  assert.equal(isLobbyAdmin(state, 'p1'), true);
  assert.equal(isLobbyAdmin(state, 'p2'), false);

  assert.ok(applyLobbyAction(state, 'p1', { type: 'configure', settings: { hotseat: true } }).ok);
  assert.equal(state.settings.hotseat, false, 'hotseat нельзя включить через настройки лобби');

  const denied = applyLobbyAction(state, 'p2', { type: 'configure', settings: { fogOfWar: false } });
  assert.equal(denied.ok, false, 'гость не меняет настройки');

  assert.ok(applyLobbyAction(state, 'p1', { type: 'setAdmin', playerId: 'p2', admin: true }).ok);
  assert.equal(isLobbyAdmin(state, 'p2'), true);
  assert.ok(
    applyLobbyAction(state, 'p2', { type: 'configure', settings: { mapSize: 12, fogOfWar: false, startArmy: 10, actionsPerTurn: 4 } }).ok,
    'админ может настраивать',
  );
  assert.equal(state.width, 12);
  assert.equal(state.tiles.length, 144);
  assert.equal(state.settings.fogOfWar, false);
  assert.ok(applyLobbyAction(state, 'p2', { type: 'paint', at: { x: 5, y: 5 }, terrain: 'water' }).ok);
  assert.equal(tileAt(state, 5, 5)?.terrain, 'water');
  assert.equal(state.settings.terrainMode, 'custom');
  const shore = hexNeighborCoords({ x: 1, y: 1 }).find((c) => tileAt(state, c.x, c.y));
  assert.ok(shore);
  assert.ok(applyLobbyAction(state, 'p1', { type: 'paint', at: shore, terrain: 'water' }).ok);

  const started = startGame(state, 'p1');
  assert.ok(started.ok);
  assert.equal(tileAt(state, shore.x, shore.y)?.terrain, 'water', 'свой рельеф у столицы не затирается');
  assert.equal(state.width, 12);
  assert.equal(currentPlayer(state)!.actionsLeft, 4);
  for (const player of state.players) {
    const capital = capitalOf(state, player.id);
    assert.equal(armyCount(capital.army), 10);
  }
  const me = state.players[0]!;
  const foe = state.players[1]!;
  const theirCap = capitalOf(state, foe.id);
  assert.equal(canSeeArmyOn(state, me.id, theirCap), true, 'без тумана видна дальняя армия');
  const masked = maskStateFor(state, me.id);
  assert.ok(armyCount(capitalOf(masked, foe.id).army) > 0, 'маска не прячет войска без тумана');

  const hostOnly = createGame('ROOM2', 'h', 1);
  addPlayer(hostOnly, 'h', 'Хост');
  addPlayer(hostOnly, 'g', 'Гость');
  assert.equal(applyLobbyAction(hostOnly, 'g', { type: 'setAdmin', playerId: 'h', admin: true }).ok, false);
  assert.ok(applyLobbyAction(hostOnly, 'h', { type: 'reroll' }).ok);
  assert.equal(hostOnly.settings.terrainMode, 'random');
  console.log('✓ лобби: размер карты, рельеф, туман, админ');
}

function checkMarkDisconnected(): void {
  const state = createGame('DISC1', 'p1', 3);
  addPlayer(state, 'p1', 'Хост');
  addPlayer(state, 'p2', 'Гость');
  markDisconnected(state, 'p2');
  assert.equal(state.players.length, 2, 'markDisconnected не удаляет игрока из лобби');
  assert.equal(state.hostId, 'p1', 'markDisconnected не меняет хоста');
  const p2 = state.players.find((p) => p.id === 'p2')!;
  assert.equal(p2.connected, false, 'игрок помечен офлайн');

  const rejoined = addPlayer(state, 'p2', 'Гость');
  assert.ok(rejoined.ok, 'вернувшийся игрок снова присоединяется');
  assert.equal(state.players.find((p) => p.id === 'p2')!.connected, true, 'после возвращения снова online');
  console.log('✓ markDisconnected не отнимает место в лобби, addPlayer возвращает игрока online');
}

function checkHotseat(): void {
  const state = createGame('SOLO1', 'p1', 42);
  assert.ok(setupHotseat(state, 'p1', 'Хост').ok);
  assert.equal(state.players.length, 2);
  assert.equal(state.settings.hotseat, true);
  assert.ok(applyLobbyAction(state, 'p1', { type: 'configure', settings: { hotseat: false } }).ok);
  assert.equal(state.settings.hotseat, true, 'hotseat в соло нельзя выключить через настройки');
  assert.ok(startGame(state, 'p1').ok);
  const first = currentPlayer(state)!;
  assert.equal(actingPlayerId(state, 'p1'), first.id, 'хост ходит за текущего игрока');
  assert.ok(applyAction(state, actingPlayerId(state, 'p1'), { type: 'endTurn' }).ok);
  const second = currentPlayer(state)!;
  assert.notEqual(second.id, first.id);
  assert.equal(actingPlayerId(state, 'p1'), second.id, 'после хода хост смотрит за другую державу');
  console.log('✓ сам с собой: хост ходит за обе державы');
}

function checkEras(): void {
  assert.equal(unitsFor('ancient').medium_infantry.name, 'Пехота');
  assert.equal(unitsFor('ancient').heavy_cavalry.name, 'Тяжёлая конница');
  assert.equal(unitsFor('medieval').light_infantry.name, 'Ополчение');
  assert.equal(unitsFor('medieval').medium_infantry.name, 'Наёмники');
  assert.equal(unitsFor('medieval').heavy_infantry.name, 'Пикинёры');
  assert.equal(unitsFor('medieval').heavy_cavalry.name, 'Рыцари');
  assert.equal(unitsFor('medieval').medium_archer.name, 'Лучники');
  assert.equal(unitsFor('medieval').heavy_archer.name, 'Арбалетчики');
  assert.equal(unitsFor('medieval').medium_horse_archer.name, 'Конные арбалетчики');
  assert.equal(unitsFor('napoleonic').light_infantry.name, 'Вольтижёры');
  assert.equal(unitsFor('napoleonic').medium_infantry.name, 'Линейная пехота');
  assert.equal(unitsFor('napoleonic').heavy_infantry.name, 'Гренадеры');
  assert.equal(unitsFor('napoleonic').light_cavalry.name, 'Гусары');
  assert.equal(unitsFor('napoleonic').medium_cavalry.name, 'Драгуны');
  assert.equal(unitsFor('napoleonic').heavy_cavalry.name, 'Кирасиры');
  assert.equal(unitsFor('napoleonic').medium_archer.name, 'Полевые пушки');
  assert.equal(unitsFor('napoleonic').heavy_archer.name, 'Тяжёлые орудия');
  assert.equal(unitsFor('napoleonic').medium_horse_archer.name, 'Конные батареи');
  assert.equal(unitsFor('napoleonic').medium_infantry.icon, '💂');
  assert.equal(unitRange('medium_infantry', 'napoleonic'), 2);
  assert.equal(unitRange('light_infantry', 'napoleonic'), 2);
  assert.equal(unitRange('heavy_infantry', 'napoleonic'), 2);
  assert.equal(unitRange('medium_cavalry', 'napoleonic'), 0);
  assert.equal(unitShotKind('medium_infantry', 'napoleonic'), 'musket');
  assert.equal(unitShotKind('light_archer', 'napoleonic'), 'musket');
  assert.equal(unitShotKind('medium_archer', 'napoleonic'), 'cannon');
  assert.equal(unitShotKind('medium_archer', 'ancient'), 'arrow');
  assert.equal(armyCount(archerArmy({ medium_infantry: 4 }, 'ancient')), 0);
  assert.equal(armyCount(archerArmy({ medium_infantry: 4 }, 'napoleonic')), 4);

  assert.equal(unitRange('heavy_archer', 'ancient'), 2);
  assert.equal(unitRange('medium_archer', 'napoleonic'), 3);
  assert.equal(unitRange('heavy_archer', 'napoleonic'), 4);
  assert.equal(unitRange('light_horse_archer', 'napoleonic'), 3);
  assert.equal(unitRange('heavy_horse_archer', 'napoleonic'), 4);
  assert.equal(armySpeed({ light_horse_archer: 1 }, 'napoleonic'), 2, 'лёгкая конная артиллерия — ход 2');
  assert.equal(armySpeed({ medium_horse_archer: 1 }, 'napoleonic'), 1, 'конные батареи — ход 1');
  assert.equal(armySpeed({ heavy_horse_archer: 1 }, 'napoleonic'), 1, 'конные гаубицы — ход 1');
  assert.equal(armySpeed({ medium_archer: 1 }, 'napoleonic'), 1, 'полевые пушки — ход 1');
  assert.equal(armySpeed({ heavy_archer: 1 }, 'napoleonic'), 1, 'тяжёлые орудия — ход 1');
  assert.equal(armyRange({ medium_archer: 1 }, 'napoleonic'), 3);
  assert.equal(armyRange({ medium_archer: 1 }, 'napoleonic', 'hills'), 4);
  assert.equal(armyRange({ heavy_archer: 1 }, 'napoleonic', 'hills'), 5);
  assert.equal(armyRange({ medium_archer: 1, medium_infantry: 4 }, 'napoleonic', 'plains'), 3);

  assert.equal(buildingsFor('medieval').fort.name, 'Замок');
  assert.equal(buildingsFor('medieval').barracks.name, 'Дружина');
  assert.equal(buildingsFor('napoleonic').palisade.name, 'Редут');
  assert.equal(commandersFor('medieval').warlord.name, 'Князь');
  assert.equal(commandersFor('napoleonic').marshal.name, 'Маршал');
  assert.equal(techsFor('napoleonic').economy.name, 'Интендантство');
  assert.equal(isEraId('ww2'), false);

  const knights = armyPower({ heavy_cavalry: 10 }, 'attack', 'archer', 'plains', { era: 'medieval' });
  const ancientCav = armyPower({ heavy_cavalry: 10 }, 'attack', 'archer', 'plains', { era: 'ancient' });
  assert.ok(knights > ancientCav, 'рыцари бьют сильнее античной тяжёлой конницы');

  const musketVsInf = armyPower({ medium_infantry: 10 }, 'attack', 'infantry', 'plains', {
    volley: true,
    era: 'napoleonic',
  });
  const musketVsCav = armyPower({ medium_infantry: 10 }, 'attack', 'cavalry', 'plains', {
    volley: true,
    era: 'napoleonic',
  });
  assert.ok(musketVsInf > musketVsCav, 'мушкетный залп косит пехоту и слаб против конницы');

  const cavVsLine = armyPower({ medium_cavalry: 10 }, 'attack', 'infantry', 'plains', { era: 'napoleonic' });
  const lineVsCav = armyPower({ medium_infantry: 10 }, 'defense', 'cavalry', 'plains', { era: 'napoleonic' });
  assert.ok(cavVsLine > lineVsCav, 'без каре конница сминает линейную пехоту');
  const cavVsSquare = armyPower({ medium_cavalry: 10 }, 'attack', 'infantry', 'plains', {
    era: 'napoleonic',
    square: true,
  });
  const squareVsCav = armyPower({ medium_infantry: 10 }, 'defense', 'cavalry', 'plains', {
    era: 'napoleonic',
    square: true,
  });
  assert.ok(cavVsSquare < squareVsCav, 'каре держит конницу');

  const pikes = armyPower({ heavy_infantry: 10 }, 'defense', 'cavalry', 'plains', { era: 'medieval' });
  const knightsMelee = armyPower({ heavy_cavalry: 10 }, 'attack', 'infantry', 'plains', { era: 'medieval' });
  assert.ok(pikes > knightsMelee, 'пики держат рыцарей без особого строя');

  const state = createGame('ERA1', 'p1', 99);
  addPlayer(state, 'p1', 'Хост');
  addPlayer(state, 'p2', 'Гость');
  assert.equal(state.settings.era, 'ancient');
  assert.equal(
    applyLobbyAction(state, 'p1', { type: 'configure', settings: { era: 'stone' as never } }).ok,
    true,
  );
  assert.equal(state.settings.era, 'ancient', 'неизвестная эпоха не принимается');
  assert.ok(applyLobbyAction(state, 'p1', { type: 'configure', settings: { era: 'medieval' } }).ok);
  assert.equal(state.settings.era, 'medieval');
  assert.ok(startGame(state, 'p1').ok);
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);
  me.resources.gold = 200;
  me.resources.iron = 200;
  const hired = applyAction(state, me.id, { type: 'recruit', at: capital, count: 1, unit: 'heavy_cavalry' });
  assert.ok(hired.ok, 'найм рыцарей');
  assert.ok(
    state.log.some((entry) => entry.text.includes('Рыцари')),
    'в журнале имя эпохи',
  );

  const nap = createGame('ERA2', 'p1', 7);
  addPlayer(nap, 'p1', 'Хост');
  addPlayer(nap, 'p2', 'Гость');
  assert.ok(applyLobbyAction(nap, 'p1', { type: 'configure', settings: { era: 'napoleonic' } }).ok);
  assert.ok(startGame(nap, 'p1').ok);
  const napMe = currentPlayer(nap)!;
  const napCap = capitalOf(nap, napMe.id);
  napMe.resources.gold = 200;
  napMe.resources.iron = 200;
  assert.ok(applyAction(nap, napMe.id, { type: 'recruit', at: napCap, count: 1, unit: 'heavy_infantry' }).ok);
  assert.ok(nap.log.some((entry) => entry.text.includes('Гренадеры')));
  const plot = neighbors(nap, napCap).find(
    (t) => t.ownerId === napMe.id && TERRAIN[t.terrain].passable && !t.building && !t.construction,
  );
  assert.ok(plot, 'рядом со столицей своя клетка под стройку');
  assert.ok(applyAction(nap, napMe.id, { type: 'build', at: plot, building: 'palisade' }).ok);
  assert.ok(nap.log.some((entry) => entry.text.includes('Редут')));
  assert.ok(applyAction(nap, napMe.id, { type: 'appoint', at: napCap, commander: 'marshal' }).ok);
  assert.ok(nap.log.some((entry) => entry.text.includes('Маршал')));

  const foe = nap.players.find((p) => p.id !== napMe.id)!;
  const foeCap = capitalOf(nap, foe.id);
  const musketTile = nap.tiles.find(
    (t) => TERRAIN[t.terrain].passable && hexDistance(t, foeCap) === 2 && t.ownerId !== foe.id,
  );
  assert.ok(musketTile, 'клетка на дальности мушкета');
  musketTile.ownerId = napMe.id;
  musketTile.army = { medium_infantry: 12 };
  musketTile.movesLeft = 1;
  musketTile.shotsLeft = 1;
  napMe.actionsLeft = 3;
  const beforeShot = armyCount(foeCap.army);
  const musketFire = applyAction(nap, napMe.id, {
    type: 'shoot',
    from: { x: musketTile.x, y: musketTile.y },
    to: { x: foeCap.x, y: foeCap.y },
  });
  assert.ok(musketFire.ok, 'линейная пехота стреляет из мушкетов');
  assert.equal(musketFire.ok && musketFire.fx?.unit, 'medium_infantry');
  assert.ok(armyCount(foeCap.army) < beforeShot, 'мушкетный залп наносит потери');

  const gunSpot = nap.tiles.find(
    (t) =>
      TERRAIN[t.terrain].passable &&
      armyCount(t.army) === 0 &&
      !t.capitalOf &&
      hexDistance(t, foeCap) >= 1 &&
      hexDistance(t, foeCap) <= 3,
  );
  assert.ok(gunSpot, 'клетка под орудия');
  gunSpot.ownerId = napMe.id;
  gunSpot.terrain = 'plains';
  gunSpot.army = { heavy_archer: 4 };
  gunSpot.movesLeft = 1;
  gunSpot.shotsLeft = 1;
  napMe.actionsLeft = 3;
  const step = neighbors(nap, gunSpot).find(
    (t) =>
      TERRAIN[t.terrain].passable &&
      armyCount(t.army) === 0 &&
      !(t.x === foeCap.x && t.y === foeCap.y) &&
      hexDistance(t, foeCap) <= 4,
  );
  assert.ok(step, 'куда сдвинуть орудия');
  assert.ok(
    applyAction(nap, napMe.id, {
      type: 'move',
      from: { x: gunSpot.x, y: gunSpot.y },
      to: { x: step.x, y: step.y },
      count: 4,
    }).ok,
    'тяжёлые орудия делают шаг',
  );
  assert.equal(step.shotsLeft, 0, 'после хода тяжёлые орудия теряют залп');
  assert.equal(
    applyAction(nap, napMe.id, {
      type: 'shoot',
      from: { x: step.x, y: step.y },
      to: { x: foeCap.x, y: foeCap.y },
    }).ok,
    false,
    'тяжёлые орудия после хода не стреляют',
  );

  console.log('✓ эпохи: имена войск, дальность орудий, лобби и найм');
}

function napoleonicGame(): GameState {
  const state = createGame('NAP1', 'p1', 21);
  addPlayer(state, 'p1', 'Первый');
  addPlayer(state, 'p2', 'Второй');
  assert.ok(applyLobbyAction(state, 'p1', { type: 'configure', settings: { era: 'napoleonic', fogOfWar: false } }).ok);
  assert.ok(startGame(state, 'p1').ok);
  return state;
}

function checkSquare(): void {
  const ancient = newGame();
  const aAtk = currentPlayer(ancient)!;
  const aDef = ancient.players.find((p) => p.id !== aAtk.id)!;
  const aCap = capitalOf(ancient, aDef.id);
  const aStage = neighbors(ancient, aCap).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(aStage);
  aStage.ownerId = aAtk.id;
  aStage.terrain = 'plains';
  aCap.terrain = 'plains';
  aStage.army = { medium_cavalry: 8 };
  aStage.movesLeft = 2;
  aCap.army = { medium_infantry: 8 };
  const ancientHit = applyAction(ancient, aAtk.id, {
    type: 'move',
    from: { x: aStage.x, y: aStage.y },
    to: { x: aCap.x, y: aCap.y },
    count: 8,
  });
  assert.ok(ancientHit.ok);
  assert.equal(ancient.pendingSquare, undefined, 'в античности каре не предлагают');
  assert.ok(ancientHit.ok && ancientHit.fx, 'бой проходит сразу');

  const state = napoleonicGame();
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const cap = capitalOf(state, defender.id);
  const staging = neighbors(state, cap).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(staging);
  staging.ownerId = attacker.id;
  staging.terrain = 'plains';
  cap.terrain = 'plains';
  staging.army = { medium_cavalry: 12 };
  staging.movesLeft = 2;
  cap.army = { medium_infantry: 12 };
  cap.square = false;
  attacker.actionsLeft = 1;

  const offered = applyAction(state, attacker.id, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: cap.x, y: cap.y },
    count: 12,
  });
  assert.ok(offered.ok);
  assert.equal(offered.ok && offered.fx, undefined, 'пока нет боя — ждём каре');
  assert.ok(state.pendingSquare, 'конница по пехоте предлагает каре');
  assert.equal(staging.ownerId, attacker.id);
  assert.equal(armyCount(staging.army), 12, 'конница ещё не пошла');
  assert.equal(attacker.actionsLeft, 1, 'действие не списано до ответа');
  autoEndTurnIfExhausted(state);
  assert.equal(currentPlayer(state)!.id, attacker.id, 'ожидание каре не заканчивает ход');

  const deniedActor = applyAction(state, attacker.id, { type: 'endTurn' });
  assert.equal(deniedActor.ok, false, 'пока ждут каре, ходить нельзя');

  const formed = applyAction(state, defender.id, { type: 'squareReply', form: true });
  assert.ok(formed.ok, 'оборона встаёт в каре');
  assert.equal(state.pendingSquare, null);
  assert.equal(cap.square, true);
  assert.ok(formed.ok && formed.fx, 'после каре идёт бой');
  assert.equal(cap.square, true, 'каре остаётся после отбитой атаки');
  assert.ok(armyCount(cap.army) > 0, 'пехота в каре жива');
  assert.ok(armyCount(staging.army) > 0, 'конница отбита, а не стёрта');

  const forecastOpen = battleForecastRatio(
    state,
    attacker,
    { medium_cavalry: 12 },
    { ...cap, army: { medium_infantry: 12 }, square: false },
    defender,
    true,
  );
  const forecastSquare = battleForecastRatio(
    state,
    attacker,
    { medium_cavalry: 12 },
    { ...cap, army: { medium_infantry: 12 }, square: true },
    defender,
    true,
  );
  assert.ok(forecastOpen > 1, 'без каре конница сильнее линии');
  assert.ok(forecastSquare < 0.7, 'по каре конница бьёт слабо');

  const hold = napoleonicGame();
  const holder = currentPlayer(hold)!;
  const other = hold.players.find((p) => p.id !== holder.id)!;
  const home = capitalOf(hold, holder.id);
  home.terrain = 'plains';
  home.army = { medium_infantry: 8 };
  const formedOwn = applyAction(hold, holder.id, { type: 'formSquare', at: { x: home.x, y: home.y } });
  assert.ok(formedOwn.ok, 'можно встать в каре своим ходом');
  assert.equal(home.square, true);
  assert.equal(holder.actionsLeft, BASE_ACTIONS - 1);
  assert.ok(applyAction(hold, holder.id, { type: 'endTurn' }).ok);
  assert.ok(applyAction(hold, currentPlayer(hold)!.id, { type: 'endTurn' }).ok);
  assert.equal(currentPlayer(hold)!.id, holder.id);
  assert.equal(home.square, true);
  assert.equal(holder.actionsLeft, BASE_ACTIONS - 1, 'каре съедает 1⚡ на старте хода');

  const cavNext = neighbors(hold, home).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(cavNext);
  cavNext.ownerId = other.id;
  cavNext.terrain = 'plains';
  cavNext.army = { medium_cavalry: 4 };
  const pinnedBreak = applyAction(hold, holder.id, { type: 'breakSquare', at: { x: home.x, y: home.y } });
  assert.equal(pinnedBreak.ok, false, 'рядом конница — каре не разойти');
  home.movesLeft = 1;
  const pinnedMove = applyAction(hold, holder.id, {
    type: 'move',
    from: { x: home.x, y: home.y },
    to: { x: cavNext.x, y: cavNext.y },
    count: 1,
  });
  assert.equal(pinnedMove.ok, false, 'из каре под конницей не выйти');
  cavNext.army = {};
  const freeBreak = applyAction(hold, holder.id, { type: 'breakSquare', at: { x: home.x, y: home.y } });
  assert.ok(freeBreak.ok, 'без конницы каре можно разойти');
  assert.equal(home.square, false);

  const forest = napoleonicGame();
  const fAtk = currentPlayer(forest)!;
  const fDef = forest.players.find((p) => p.id !== fAtk.id)!;
  const fCap = capitalOf(forest, fDef.id);
  const fStage = neighbors(forest, fCap).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(fStage);
  fStage.ownerId = fAtk.id;
  fStage.terrain = 'plains';
  fCap.terrain = 'forest';
  fStage.army = { medium_cavalry: 6 };
  fStage.movesLeft = 2;
  fCap.army = { medium_infantry: 6 };
  const forestHit = applyAction(forest, fAtk.id, {
    type: 'move',
    from: { x: fStage.x, y: fStage.y },
    to: { x: fCap.x, y: fCap.y },
    count: 6,
  });
  assert.ok(forestHit.ok);
  assert.ok(!forest.pendingSquare, 'в лесу каре не строят');

  const solo = createGame('SOLO2', 'p1', 5);
  assert.ok(setupHotseat(solo, 'p1', 'Хост').ok);
  assert.ok(applyLobbyAction(solo, 'p1', { type: 'configure', settings: { era: 'napoleonic', fogOfWar: false } }).ok);
  assert.ok(startGame(solo, 'p1').ok);
  const sAtk = currentPlayer(solo)!;
  const sDef = solo.players.find((p) => p.id !== sAtk.id)!;
  const sCap = capitalOf(solo, sDef.id);
  const sStage = neighbors(solo, sCap).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(sStage);
  sStage.ownerId = sAtk.id;
  sStage.terrain = 'plains';
  sCap.terrain = 'plains';
  sStage.army = { medium_cavalry: 5 };
  sStage.movesLeft = 2;
  sCap.army = { medium_infantry: 8 };
  assert.ok(
    applyAction(solo, actingPlayerId(solo, 'p1'), {
      type: 'move',
      from: { x: sStage.x, y: sStage.y },
      to: { x: sCap.x, y: sCap.y },
      count: 5,
    }).ok,
  );
  assert.ok(solo.pendingSquare);
  const hostReply = applyAction(solo, 'p1', { type: 'squareReply', form: false });
  assert.ok(hostReply.ok, 'в партии сам с собой хост отвечает за каре');
  assert.equal(sCap.square, false);

  console.log('✓ каре: выбор, слабость конницы, содержание и запрет выйти под конями');
}

function checkValidateActions(): void {
  const badGame: unknown[] = [
    null,
    {},
    { type: 'build' },
    { type: 'build', at: { x: 1, y: 1 }, building: 'constructor' },
    { type: 'recruit', at: { x: 0, y: 0 }, count: NaN },
    { type: 'move', from: { x: 'a', y: 0 }, to: { x: 1, y: 1 }, count: 1 },
    { type: 'hack' },
  ];
  for (const raw of badGame) {
    assert.equal(parseGameAction(raw), null, `должно быть отклонено: ${JSON.stringify(raw)}`);
  }
  assert.ok(
    parseGameAction({ type: 'move', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, count: 3 }),
    'корректный move проходит',
  );
  assert.ok(parseGameAction({ type: 'endTurn' }), 'корректный endTurn проходит');
  assert.ok(parseGameAction({ type: 'squareReply', form: true }), 'корректный squareReply проходит');

  const badLobby: unknown[] = [
    null,
    {},
    { type: 'paint' },
    { type: 'configure' },
    { type: 'setAdmin', playerId: 'p1', admin: 'yes' },
  ];
  for (const raw of badLobby) {
    assert.equal(parseLobbyAction(raw), null, `лобби-действие должно быть отклонено: ${JSON.stringify(raw)}`);
  }
  assert.ok(
    parseLobbyAction({ type: 'configure', settings: { fogOfWar: false } }),
    'корректный configure проходит',
  );

  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);
  assert.doesNotThrow(() => {
    applyAction(state, me.id, { type: 'recruit', at: capital, count: 1, unit: 'constructor' as any });
  }, 'подделанный unit не должен ронять движок');
  console.log('✓ валидация входящих действий отбивает мусор');
}

/** Наполеоника: свежая конница рядом с пехотой в столице соперника. */
function napoleonicCavalryVsInfantry(): { state: GameState; attackerId: string; defenderId: string; staging: Tile; cap: Tile } {
  const state = napoleonicGame();
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const cap = capitalOf(state, defender.id);
  const staging = neighbors(state, cap).find((t) => TERRAIN[t.terrain].passable);
  assert.ok(staging);
  staging.ownerId = attacker.id;
  staging.terrain = 'plains';
  cap.terrain = 'plains';
  staging.army = { medium_cavalry: 12 };
  staging.movesLeft = 2;
  cap.army = { medium_infantry: 12 };
  cap.square = false;
  return { state, attackerId: attacker.id, defenderId: defender.id, staging, cap };
}

function checkSquareOfferNeedsAction(): void {
  const { state, attackerId, staging, cap } = napoleonicCavalryVsInfantry();
  currentPlayer(state)!.actionsLeft = 0;
  const hit = applyAction(state, attackerId, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: cap.x, y: cap.y },
    count: 12,
  });
  assert.equal(hit.ok, false, 'без действий свежая конница не атакует');
  assert.ok(!state.pendingSquare, 'и каре не предлагают');
  console.log('✓ каре не предлагают, если у атакующего нет действий');
}

function checkSquareReplyFailSafe(): void {
  const { state, attackerId, defenderId, staging, cap } = napoleonicCavalryVsInfantry();
  const offered = applyAction(state, attackerId, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: cap.x, y: cap.y },
    count: 12,
  });
  assert.ok(offered.ok && state.pendingSquare, 'каре предложено');
  currentPlayer(state)!.actionsLeft = 0; // повтор хода теперь невозможен
  const reply = applyAction(state, defenderId, { type: 'squareReply', form: false });
  assert.ok(reply.ok, 'ответ обороны принимается, чтобы состояние разослали всем');
  assert.equal(state.pendingSquare, null, 'ожидание каре снято');
  assert.equal(armyCount(staging.army), 12, 'атака не состоялась');
  console.log('✓ сорвавшаяся после каре атака не вешает партию');
}

function checkEliminateClearsSquare(): void {
  const state = newGame();
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const enemyCapital = capitalOf(state, defender.id);
  const around = neighbors(state, enemyCapital).filter((t) => TERRAIN[t.terrain].passable);
  const outpost = around[0]!;
  const staging = around[1]!;
  outpost.ownerId = defender.id;
  outpost.army = { medium_infantry: 3 };
  outpost.square = true;
  staging.ownerId = attacker.id;
  staging.terrain = 'plains';
  staging.army = { heavy_cavalry: 200 };
  staging.movesLeft = 2;
  const result = applyAction(state, attacker.id, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: enemyCapital.x, y: enemyCapital.y },
    count: 200,
  });
  assert.ok(result.ok);
  assert.equal(outpost.ownerId, attacker.id, 'земли павшей державы переходят победителю');
  assert.equal(outpost.square, false, 'каре павшей державы не достаётся победителю');
  console.log('✓ падение державы снимает её каре');
}

function checkLobbyHostReassign(): void {
  const state = createGame('HOSTX', 'p1', 1);
  addPlayer(state, 'p1', 'Первый');
  removePlayer(state, 'p1');
  assert.equal(state.players.length, 0);
  addPlayer(state, 'p2', 'Второй');
  assert.equal(state.hostId, 'p2', 'в опустевшей комнате хостом становится вошедший');
  addPlayer(state, 'p3', 'Третий');
  assert.equal(state.hostId, 'p2', 'следующий игрок хоста не отнимает');

  const botRoom = createGame('HOSTY', 'creator', 2);
  addPlayer(botRoom, 'friend', 'Друг');
  assert.equal(botRoom.hostId, 'creator', 'комната из /newgame ждёт своего создателя');
  console.log('✓ опустевшее лобби получает нового хоста');
}

function checkForecastCommander(): void {
  const state = newGame();
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const cap = capitalOf(state, defender.id);
  const army = { medium_infantry: 10 };
  const base = battleForecastRatio(state, attacker, army, cap, defender);
  const withWarlord = battleForecastRatio(state, attacker, army, cap, defender, false, {}, 'warlord');
  assert.ok(withWarlord > base, 'командир атаки повышает прогноз');
  cap.commander = 'marshal';
  const vsMarshal = battleForecastRatio(state, attacker, army, cap, defender);
  assert.ok(vsMarshal < base, 'маршал обороны понижает прогноз');
  cap.commander = null;
  cap.routedTurns = 1;
  const vsRouted = battleForecastRatio(state, attacker, army, cap, defender);
  assert.ok(vsRouted > base, 'бегущая оборона слабее и в прогнозе');
  console.log('✓ прогноз боя учитывает командиров и бегство');
}

function checkShootNeedsVision(): void {
  const state = newGame();
  const attacker = currentPlayer(state)!;
  const defender = state.players.find((p) => p.id !== attacker.id)!;
  const shooter = capitalOf(state, attacker.id);
  writeWings(shooter, [{ army: { medium_archer: 10 }, movesLeft: 1, shotsLeft: 1 }]);
  // Цель на дальности залпа, но в лесу и не вплотную к нашим войскам — её не видно.
  const target = state.tiles.find(
    (t) =>
      hexDistance(t, shooter) === 2 &&
      !neighbors(state, t).some((n) => n.ownerId === attacker.id && armyCount(n.army) > 0),
  );
  assert.ok(target);
  target.terrain = 'forest';
  target.ownerId = defender.id;
  target.army = { medium_infantry: 5 };
  assert.equal(canSeeArmyOn(state, attacker.id, target), false, 'войско в лесу не видно издалека');
  const hidden = applyAction(state, attacker.id, {
    type: 'shoot',
    from: { x: shooter.x, y: shooter.y },
    to: { x: target.x, y: target.y },
  });
  assert.equal(hidden.ok, false, 'по невидимой цели не стреляют');

  state.settings.fogOfWar = false;
  const open = applyAction(state, attacker.id, {
    type: 'shoot',
    from: { x: shooter.x, y: shooter.y },
    to: { x: target.x, y: target.y },
  });
  assert.ok(open.ok, 'без тумана та же цель доступна');
  console.log('✓ залп только по видимой цели');
}

checkStart();
checkValidateActions();
checkLobbySettings();
checkHotseat();
checkMarkDisconnected();
checkEras();
checkSquare();
checkActionLimit();
checkNoAutoEndDuringFreeMarch();
checkBattleAndElimination();
checkFailedAttack();
checkJointAttack();
checkStarvation();
checkUnitRoster();
checkFreshRecruitCanMove();
checkMovementCap();
checkConstruction();
checkVolley();
checkVolleyWipeClearsSquare();
checkCasualtiesAndCommander();
checkCharge();
checkMergeKeepsWaitingStack();
checkMixedStackSplit();
checkForestMoveFxHidden();
checkVision();
checkBuildingMemory();
checkHexGrid();
checkSquareOfferNeedsAction();
checkSquareReplyFailSafe();
checkEliminateClearsSquare();
checkLobbyHostReassign();
checkForecastCommander();
checkShootNeedsVision();
console.log('\nВсе проверки правил пройдены.');
