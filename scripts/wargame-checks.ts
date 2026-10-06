/**
 * Проверки режима «Варгейм»: закупка вслепую, отряды без слияния, потери и лечение,
 * укрепления, счёт убитых отрядов и победа. Вызываются из smoke.ts.
 */
import assert from 'node:assert/strict';
import {
  actingPlayerId,
  addAiPlayer,
  addPlayer,
  applyAction,
  applyDeployAction,
  applyLobbyAction,
  armyCount,
  autoKillGoal,
  computeIncome,
  createGame,
  currentPlayer,
  deployZone,
  killGoalOf,
  maskStateFor,
  parseDeployAction,
  playerById,
  scoreOf,
  setupHotseat,
  squadPrice,
  squadSize,
  startGame,
  stepAi,
  tileAt,
  writeWings,
  zoneOwnerAt,
} from '../shared/src/index.js';
import type { AiLevel, GameSettings, GameState, Tile, UnitId } from '../shared/src/index.js';

function warGame(settings: Partial<GameSettings> = {}, seed = 4242): GameState {
  const state = createGame('WAR01', 'p1', seed);
  addPlayer(state, 'p1', 'Первый');
  addPlayer(state, 'p2', 'Второй');
  assert.ok(applyLobbyAction(state, 'p1', { type: 'configure', settings: { mode: 'wargame', ...settings } }).ok);
  assert.ok(startGame(state, 'p1').ok);
  return state;
}

/** Обе армии закуплены автоматически, бой начат. */
function toBattle(state: GameState): void {
  for (const p of state.players) {
    assert.ok(applyDeployAction(state, p.id, { type: 'auto' }).ok);
    assert.ok(applyDeployAction(state, p.id, { type: 'ready', ready: true }).ok);
  }
  assert.equal(state.phase, 'playing');
}

/** Чистое поле: всё равнина, отрядов нет. */
function clearField(state: GameState): void {
  for (const t of state.tiles) {
    t.terrain = 'plains';
    t.building = null;
    t.construction = null;
    t.ownerId = null;
    t.commander = null;
    t.squad = null;
    writeWings(t, []);
  }
}

function put(state: GameState, x: number, y: number, owner: string, unit: UnitId, n: number, size = n): Tile {
  const tile = tileAt(state, x, y)!;
  tile.ownerId = owner;
  writeWings(tile, [{ army: { [unit]: n }, movesLeft: 3, shotsLeft: 1 }]);
  tile.squad = { size, rest: 0 };
  return tile;
}

function sides(state: GameState): { me: string; foe: string } {
  const me = currentPlayer(state)!.id;
  return { me, foe: state.players.find((p) => p.id !== me)!.id };
}

function endTurn(state: GameState): void {
  assert.ok(applyAction(state, currentPlayer(state)!.id, { type: 'endTurn' }).ok);
}

function checkWargameDeploy(): void {
  const state = warGame({ warCapital: 500 });
  assert.equal(state.phase, 'deploy');
  assert.ok(state.tiles.every((t) => !t.capitalOf && !t.ownerId), 'без столиц и земли');
  const p1 = playerById(state, 'p1')!;
  assert.equal(p1.resources.gold, 500, 'деньги = капитал');
  const z1 = deployZone(state, 'p1');
  const z2 = deployZone(state, 'p2');
  assert.ok(z1.length >= 10 && z2.length === z1.length, 'зоны одинаковые и не пустые');
  assert.ok(z1.every((t) => zoneOwnerAt(state, t.x, t.y) === 'p1'));
  const at = { x: z1[0]!.x, y: z1[0]!.y };
  const outside = z2[0]!;
  assert.equal(applyDeployAction(state, 'p1', { type: 'buySquad', at: outside, unit: 'medium_infantry' }).ok, false, 'чужая зона');
  assert.equal(applyDeployAction(state, 'p1', { type: 'ready', ready: true }).ok, false, 'без отрядов не готов');
  assert.ok(applyDeployAction(state, 'p1', { type: 'buySquad', at, unit: 'medium_infantry' }).ok);
  const price = squadPrice('ancient', 'medium_infantry');
  assert.equal(p1.resources.gold, 500 - price);
  assert.equal(armyCount(tileAt(state, at.x, at.y)!.army), squadSize('ancient', 'medium_infantry'));
  assert.equal(squadSize('ancient', 'light_cavalry'), 5);
  assert.equal(squadSize('ancient', 'heavy_infantry'), 3);
  assert.equal(applyDeployAction(state, 'p1', { type: 'buySquad', at, unit: 'light_archer' }).ok, false, 'клетка занята');
  assert.ok(applyDeployAction(state, 'p1', { type: 'buyCommander', at, commander: 'warlord' }).ok);
  assert.ok(applyDeployAction(state, 'p1', { type: 'buyFort', building: 'palisade' }).ok);
  assert.equal(applyDeployAction(state, 'p1', { type: 'buyFort', building: 'farm' }).ok, false, 'ферма не продаётся');
  // Вслепую: второй не видит армию, золото и укрепления первого.
  const seen = maskStateFor(state, 'p2');
  assert.equal(armyCount(tileAt(seen, at.x, at.y)!.army), 0);
  assert.equal(playerById(seen, 'p1')!.resources.gold, 0);
  assert.equal(playerById(seen, 'p1')!.forts!.length, 0);
  // Продажа возвращает всё.
  assert.ok(applyDeployAction(state, 'p1', { type: 'clear' }).ok);
  assert.equal(p1.resources.gold, 500);
  assert.ok(applyDeployAction(state, 'p1', { type: 'auto' }).ok);
  assert.ok(p1.resources.gold < squadPrice('ancient', 'light_infantry') + 60, 'авто тратит почти всё');
  assert.ok(applyDeployAction(state, 'p1', { type: 'ready', ready: true }).ok);
  assert.equal(applyDeployAction(state, 'p1', { type: 'clear' }).ok, false, 'после «Готов» армию не менять');
  assert.equal(state.phase, 'deploy', 'ждём второго');
  assert.ok(applyDeployAction(state, 'p2', { type: 'auto' }).ok);
  assert.ok(applyDeployAction(state, 'p2', { type: 'ready', ready: true }).ok);
  assert.equal(state.phase, 'playing');
  assert.equal(state.round, 1);
  assert.equal(computeIncome(state, currentPlayer(state)!.id).gold, 0, 'дохода нет');
  assert.equal(state.settings.randomEvents, false);
  console.log('✓ варгейм: закупка вслепую, зоны, продажа, старт боя');
}

function checkWargameSquadMoves(): void {
  const state = warGame();
  toBattle(state);
  clearField(state);
  const { me, foe } = sides(state);
  const a = put(state, 3, 3, me, 'medium_infantry', 4);
  put(state, 4, 3, me, 'light_archer', 5);
  put(state, 8, 8, foe, 'light_infantry', 5);
  const squad = a.squad!;
  assert.equal(applyAction(state, me, { type: 'move', from: { x: 3, y: 3 }, to: { x: 4, y: 3 }, count: 4 }).ok, false, 'на своего нельзя');
  const r = applyAction(state, me, { type: 'move', from: { x: 3, y: 3 }, to: { x: 2, y: 3 }, count: 1 });
  assert.ok(r.ok, r.ok ? '' : r.error);
  const b = tileAt(state, 2, 3)!;
  assert.equal(armyCount(b.army), 4, 'отряд идёт целиком');
  assert.equal(b.squad, squad, 'запись отряда едет с ним');
  assert.equal(a.ownerId, null, 'пустая клетка ничья');
  assert.equal(armyCount(a.army), 0);
  assert.ok(squad.active, 'ходивший отряд не отдыхает');
  console.log('✓ варгейм: отряд ходит целиком, без слияния');
}

function checkWargameKillAndWin(): void {
  const state = warGame({ killGoal: 0 });
  toBattle(state);
  clearField(state);
  const { me, foe } = sides(state);
  put(state, 4, 4, me, 'heavy_cavalry', 3);
  put(state, 5, 4, foe, 'light_archer', 1, 5);
  const r = applyAction(state, me, { type: 'move', from: { x: 4, y: 4 }, to: { x: 5, y: 4 }, count: 3 });
  assert.ok(r.ok);
  assert.equal(playerById(state, me)!.stats.squadsKilled, 1, 'отряд засчитан');
  assert.equal(playerById(state, foe)!.stats.squadsLost, 1);
  assert.equal(playerById(state, foe)!.alive, false, 'без отрядов армия разбита');
  assert.equal(state.phase, 'finished');
  assert.equal(state.winnerId, me);
  console.log('✓ варгейм: уничтоженный отряд засчитан, последняя армия побеждает');
}

function checkWargameKillGoal(): void {
  const state = warGame({ killGoal: 1 });
  assert.equal(killGoalOf(state.settings), 1);
  assert.equal(killGoalOf({ killGoal: -1, warCapital: 600 }), autoKillGoal(600));
  toBattle(state);
  clearField(state);
  const { me, foe } = sides(state);
  put(state, 4, 4, me, 'heavy_cavalry', 3);
  put(state, 5, 4, foe, 'light_archer', 1, 5);
  put(state, 9, 9, foe, 'heavy_infantry', 3);
  assert.ok(applyAction(state, me, { type: 'move', from: { x: 4, y: 4 }, to: { x: 5, y: 4 }, count: 3 }).ok);
  assert.equal(playerById(state, foe)!.alive, true, 'у врага остались отряды');
  assert.equal(state.phase, 'finished', 'цель по отрядам достигнута');
  assert.equal(state.winnerId, me);
  console.log('✓ варгейм: победа за N уничтоженных отрядов');
}

function checkWargameHeal(): void {
  const state = warGame();
  toBattle(state);
  clearField(state);
  const { me, foe } = sides(state);
  const t = put(state, 2, 2, me, 'medium_infantry', 2, 4);
  put(state, 9, 9, foe, 'medium_infantry', 4);
  const turn = () => {
    endTurn(state); // мой ход
    endTurn(state); // ход врага
  };
  turn();
  assert.equal(armyCount(t.army), 2, 'один ход покоя — ещё рано');
  turn();
  assert.equal(armyCount(t.army), 3, 'два хода покоя — +1 юнит');
  turn();
  turn();
  assert.equal(armyCount(t.army), 4);
  turn();
  turn();
  assert.equal(armyCount(t.army), 4, 'не больше размера покупки');
  // Ход сбивает покой.
  t.squad!.rest = 1;
  writeWings(t, [{ army: { medium_infantry: 2 }, movesLeft: 1, shotsLeft: 1 }]);
  assert.ok(applyAction(state, me, { type: 'move', from: { x: 2, y: 2 }, to: { x: 3, y: 2 }, count: 2 }).ok);
  const moved = tileAt(state, 3, 2)!;
  turn();
  assert.equal(moved.squad!.rest, 0, 'после хода покой с нуля');
  console.log('✓ варгейм: отряд лечится за 2 хода покоя');
}

function checkWargameFort(): void {
  const state = warGame({ warCapital: 600 });
  const z = deployZone(state, 'p1')[3]!;
  assert.ok(applyDeployAction(state, 'p1', { type: 'buySquad', at: z, unit: 'heavy_infantry' }).ok);
  assert.ok(applyDeployAction(state, 'p1', { type: 'buyFort', building: 'palisade' }).ok);
  assert.ok(applyDeployAction(state, 'p1', { type: 'buyFort', building: 'palisade' }).ok);
  assert.ok(applyDeployAction(state, 'p1', { type: 'ready', ready: true }).ok);
  assert.ok(applyDeployAction(state, 'p2', { type: 'auto' }).ok);
  assert.ok(applyDeployAction(state, 'p2', { type: 'ready', ready: true }).ok);
  if (currentPlayer(state)!.id !== 'p1') endTurn(state);
  const tile = tileAt(state, z.x, z.y)!;
  tile.terrain = 'plains';
  const empty = state.tiles.find((t) => armyCount(t.army) === 0 && t.terrain !== 'water' && t.terrain !== 'mountains')!;
  assert.equal(applyAction(state, 'p1', { type: 'build', at: empty, building: 'palisade' }).ok, false, 'только под своим отрядом');
  assert.equal(applyAction(state, 'p1', { type: 'build', at: z, building: 'fort' }).ok, false, 'крепость не куплена');
  assert.ok(applyAction(state, 'p1', { type: 'build', at: z, building: 'palisade' }).ok);
  assert.equal(playerById(state, 'p1')!.forts!.length, 1, 'укрепление списано');
  assert.equal(tile.construction?.building, 'palisade');
  endTurn(state);
  endTurn(state);
  assert.equal(tile.building, 'palisade', 'частокол готов за 1 ход');
  // Вторую стройку срывает уход отряда.
  const next = state.tiles.find(
    (t) => armyCount(t.army) === 0 && t.terrain !== 'water' && t.terrain !== 'mountains' && Math.abs(t.x - z.x) + Math.abs(t.y - z.y) === 1 && !t.building,
  );
  if (next) {
    tile.building = null;
    assert.ok(applyAction(state, 'p1', { type: 'build', at: z, building: 'palisade' }).ok);
    writeWings(tile, [{ army: { ...tile.army }, movesLeft: 2, shotsLeft: 1 }]);
    const moved = applyAction(state, 'p1', { type: 'move', from: z, to: next, count: 1 });
    if (moved.ok) assert.equal(tile.construction, null, 'отряд ушёл — стройка сорвана');
  }
  console.log('✓ варгейм: укрепление ставит отряд, без отряда стройка срывается');
}

function checkWargameRoundsScore(): void {
  const state = warGame({ maxRounds: 15, killGoal: 0 });
  toBattle(state);
  clearField(state);
  const { me, foe } = sides(state);
  put(state, 4, 4, me, 'heavy_cavalry', 3);
  put(state, 5, 4, foe, 'light_archer', 1, 5);
  put(state, 9, 9, foe, 'heavy_cavalry', 3);
  put(state, 9, 7, foe, 'heavy_cavalry', 3);
  assert.ok(applyAction(state, me, { type: 'move', from: { x: 4, y: 4 }, to: { x: 5, y: 4 }, count: 3 }).ok);
  assert.ok(scoreOf(state, foe) < scoreOf(state, me), 'убитый отряд дороже армии');
  while (state.phase === 'playing') endTurn(state);
  assert.equal(state.winnerId, me, 'по раундам — у кого больше убитых отрядов');
  console.log('✓ варгейм: по лимиту раундов побеждает счёт отрядов');
}

function checkWargameHotseat(): void {
  const state = createGame('WARHS', 'host', 77);
  assert.ok(setupHotseat(state, 'host', 'Я').ok);
  assert.ok(applyLobbyAction(state, 'host', { type: 'configure', settings: { mode: 'wargame' } }).ok);
  assert.ok(startGame(state, 'host').ok);
  assert.equal(actingPlayerId(state, 'host'), 'host');
  assert.ok(applyDeployAction(state, 'host', { type: 'auto' }).ok);
  assert.ok(applyDeployAction(state, 'host', { type: 'ready', ready: true }).ok);
  const rival = actingPlayerId(state, 'host');
  assert.notEqual(rival, 'host', 'после «Готов» — армия соперника');
  assert.ok(applyDeployAction(state, rival, { type: 'auto' }).ok);
  assert.ok(applyDeployAction(state, rival, { type: 'ready', ready: true }).ok);
  assert.equal(state.phase, 'playing');
  console.log('✓ варгейм: соло — расстановка за обоих по очереди');
}

function checkWargameValidate(): void {
  assert.deepEqual(parseDeployAction({ type: 'buySquad', at: { x: 1, y: 2 }, unit: 'medium_infantry' }), {
    type: 'buySquad',
    at: { x: 1, y: 2 },
    unit: 'medium_infantry',
  });
  assert.equal(parseDeployAction({ type: 'buySquad', at: { x: 1, y: 2 }, unit: 'dragon' }), null);
  assert.equal(parseDeployAction({ type: 'ready', ready: 'yes' }), null);
  assert.equal(parseDeployAction({ type: 'hack' }), null);
  assert.deepEqual(parseDeployAction({ type: 'buyFort', building: 'fort' }), { type: 'buyFort', building: 'fort' });
  console.log('✓ варгейм: проверка закупки от клиента');
}

function checkWargameAi(): void {
  const runs: { levels: AiLevel[]; era: 'ancient' | 'medieval' | 'napoleonic'; size: number; capital: number }[] = [
    { levels: ['normal', 'hard'], era: 'ancient', size: 10, capital: 500 },
    { levels: ['easy', 'normal', 'hard'], era: 'medieval', size: 12, capital: 800 },
    { levels: ['hard', 'hard', 'normal', 'easy'], era: 'napoleonic', size: 14, capital: 1000 },
  ];
  for (const run of runs) {
    const state = createGame('WARAI', 'host', 99 + run.size);
    for (const level of run.levels) assert.ok(addAiPlayer(state, level).ok);
    state.settings.mode = 'wargame';
    state.settings.era = run.era;
    state.settings.mapSize = run.size;
    state.settings.warCapital = run.capital;
    state.settings.maxRounds = 30;
    state.width = run.size;
    state.height = run.size;
    assert.ok(startGame(state, 'host').ok);
    assert.equal(state.phase, 'playing', 'ИИ закупаются и готовы сразу');
    let steps = 0;
    let rejected = 0;
    let attempts = 0;
    let fights = 0;
    while (state.phase === 'playing') {
      assert.ok(steps++ < 20000, 'ИИ не довёл варгейм до конца');
      const actor = state.pendingSquare ? state.pendingSquare.defenderId : currentPlayer(state)!.id;
      const step = stepAi(state, actor);
      assert.ok(step.result, 'у ИИ всегда есть что сделать');
      attempts += step.attempts;
      rejected += step.rejected;
      if (step.action && (step.action.type === 'shoot' || (step.result.ok && step.result.fx?.battle && step.result.fx.battle !== 'none'))) fights += 1;
    }
    assert.equal(state.phase, 'finished');
    assert.ok(fights > 3, `${run.era}: ИИ дерётся (${fights})`);
    assert.ok(rejected / attempts < 0.2, `${run.era}: отклонено ${rejected}/${attempts}`);
    for (const t of state.tiles) {
      if (armyCount(t.army) === 0) assert.equal(t.ownerId, null, 'пустые клетки ничьи');
      else assert.ok(armyCount(t.army) <= (t.squad?.size ?? 0), 'отряд не больше покупки');
    }
    const kills = state.players.reduce((n, p) => n + p.stats.squadsKilled, 0);
    console.log(`  ${run.era}: раунд ${state.round}, убито отрядов ${kills}, победил ${playerById(state, state.winnerId ?? '')?.name ?? '—'}`);
  }
  console.log('✓ варгейм: ИИ закупается и доигрывает партию');
}

export function runWargameChecks(): void {
  checkWargameDeploy();
  checkWargameSquadMoves();
  checkWargameKillAndWin();
  checkWargameKillGoal();
  checkWargameHeal();
  checkWargameFort();
  checkWargameRoundsScore();
  checkWargameHotseat();
  checkWargameValidate();
  checkWargameAi();
}
