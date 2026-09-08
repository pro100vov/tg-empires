/**
 * Прогон правил без интерфейса: проверяет экономику, лимит действий, бой,
 * падение державы при потере столицы и голод. Запуск: npm run smoke
 */
import assert from 'node:assert/strict';
import {
  addPlayer,
  applyAction,
  autoEndTurnIfExhausted,
  computeIncome,
  createGame,
  currentPlayer,
  startGame,
  tileAt,
  upkeepFor,
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
    assert.equal(capital.army, 6, 'в столице стартовый гарнизон');
    assert.ok(capital.ownerId === player.id);
    const income = computeIncome(state, player.id);
    assert.ok(income.gold > 0 && income.food > 0, 'столица приносит доход');
  }
  assert.equal(currentPlayer(state)!.actionsLeft, 3, 'три действия в начале хода');
  console.log('✓ старт партии, столицы и доход');
}

function checkActionLimit(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);

  for (let i = 0; i < 3; i++) {
    const result = applyAction(state, me.id, { type: 'recruit', at: capital, count: 1 });
    assert.ok(result.ok, `найм №${i + 1} должен пройти`);
    autoEndTurnIfExhausted(state);
  }
  assert.notEqual(currentPlayer(state)!.id, me.id, 'после трёх действий ход уходит сопернику');

  const late = applyAction(state, me.id, { type: 'recruit', at: capital, count: 1 });
  assert.equal(late.ok, false, 'чужой ход — действие отклонено');
  console.log('✓ лимит действий и переход хода');
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
  staging.army = 200;

  const result = applyAction(state, attacker.id, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: enemyCapital.x, y: enemyCapital.y },
    count: 200,
  });

  assert.ok(result.ok, 'атака должна выполниться');
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
  staging.army = 1;

  applyAction(state, attacker.id, {
    type: 'move',
    from: { x: staging.x, y: staging.y },
    to: { x: enemyCapital.x, y: enemyCapital.y },
    count: 1,
  });

  assert.equal(enemyCapital.ownerId, defender.id, 'слабая атака не берёт столицу');
  assert.ok(enemyCapital.army >= 1, 'у обороны остаются войска');
  assert.equal(state.phase, 'playing');
  console.log('✓ заведомо слабая атака отбита');
}

function checkStarvation(): void {
  const state = newGame();
  const me = currentPlayer(state)!;
  const capital = capitalOf(state, me.id);

  capital.army = 100;
  me.resources.food = 0;
  const upkeep = upkeepFor(state, me.id);
  assert.equal(upkeep, 50, 'содержание — одна еда на два отряда');

  // Прокручиваем круг, чтобы у игрока начался новый ход с недостатком еды.
  applyAction(state, me.id, { type: 'endTurn' });
  const other = currentPlayer(state)!;
  applyAction(state, other.id, { type: 'endTurn' });

  assert.equal(currentPlayer(state)!.id, me.id);
  assert.ok(capital.army < 100, 'без еды часть войск дезертирует');
  console.log('✓ содержание армии и дезертирство при голоде');
}

checkStart();
checkActionLimit();
checkBattleAndElimination();
checkFailedAttack();
checkStarvation();
console.log('\nВсе проверки правил пройдены.');
