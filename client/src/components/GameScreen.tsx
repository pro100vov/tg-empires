import { useEffect, useMemo, useState } from 'react';
import {
  BUILDINGS,
  COMMANDER_IDS,
  COMMANDERS,
  DEFAULT_UNIT,
  TERRAIN,
  UNIT_IDS,
  UNITS,
  unitsFor,
  buildingsFor,
  commandersFor,
  eraOf,
  ERAS,
  archerArmy,
  armyCount,
  armyRange,
  HILLS_VOLLEY_BONUS,
  armySpeed,
  armyCanCharge,
  armyCanKite,
  armyRidesHorses,
  CHARGE_ATTACK,
  CHARGE_COST,
  enterHaltsArmy,
  enterMoveCost,
  moveHaltsOnEnter,
  spentMoveCost,
  terrainMoveHint,
  battleForecastRatio,
  allyStacksCovering,
  chargePathOpen,
  coordKey,
  hexDistance,
  walkReachable,
  mergeArmies,
  mixWarning,
  armyUnitIds,
  unitRange,
  tileAt,
  ensureWings,
  mobileCount,
  takeFromWings,
  wingsAlreadyMarching,
  wingsToArmy,
  wingMoveRange,
  computeIncome,
  upkeepFor,
  canWatchTile,
  canAnswerSquare,
  armyHasHeavyArtillery,
  tileHasMarched,
  MOVED_VOLLEY,
  canFormSquare,
  shouldOfferSquare,
  squarePinned,
} from '@tge/shared';
import type { Army, BuildingType, CommanderId, Coord, EraId, GameAction, GameFx, GameState, Tile, UnitClass, UnitId } from '@tge/shared';
import MapBoard from './MapBoard';
import TechModal from './TechModal';
import { haptic, hapticResult } from '../telegram';

interface Props {
  state: GameState;
  meId: string;
  viewerId: string;
  act: (action: GameAction) => Promise<{ ok: boolean; fx?: GameFx; state?: GameState }>;
  notify: (message: string) => void;
  fx: GameFx | null;
}

type Sheet = 'recruit' | 'build' | 'commander' | null;
type PickMode = 'none' | 'move' | 'shoot';

function maxAffordable(gold: number, iron: number, food: number, unit: UnitId): number {
  const cost = UNITS[unit].cost;
  const byGold = cost.gold ? Math.floor(gold / cost.gold) : Number.POSITIVE_INFINITY;
  const byIron = cost.iron ? Math.floor(iron / cost.iron) : Number.POSITIVE_INFINITY;
  const byFood = cost.food ? Math.floor(food / cost.food) : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(byGold, byIron, byFood));
}

function fmtStat(n: number): string {
  return String(Number(n.toFixed(2)));
}

function mpSpan(values: number[]): string {
  if (values.length === 0) return '0';
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? String(max) : `${min}–${max}`;
}

function beatsExplain(id: UnitId, era: EraId): { label: string; hint: string } {
  const cls = UNITS[id].class;
  const label = ERAS[era].beats[cls];
  const hints: Record<EraId, Record<UnitClass, string>> = {
    ancient: {
      infantry: 'Пехота бьёт конницу сильнее и меньше от неё страдает. Лучники, наоборот, косят пехоту издалека.',
      cavalry: 'Конница сильнее стрелков: догоняет и рубит, пока те не успели отойти. Против пехоты кони слабее.',
      archer: 'Лучники сильнее пехоты: залп бьёт строй до рукопашной. Конница для них опасна.',
    },
    medieval: {
      infantry: 'Пики держат рыцарский таран: пехота бьёт конницу сильнее. Стрелки выбивают пехоту издалека.',
      cavalry: 'Таран сминает стрелков. Против пик конница слабее.',
      archer: 'Стрелки сильнее пехоты. Рыцари для них опасны, если доскакали.',
    },
    napoleonic: {
      infantry: 'Линия без каре уязвима для конницы. В каре кони бьют очень слабо, но строй стоит 1⚡ за ход и сам отвечает слабо. Мушкеты косят пехоту, против коней залп слабее.',
      cavalry: 'Кавалерия сминает батареи и линейную пехоту, которая не встала в каре. По каре кони бьют почти впустую.',
      archer: 'Картечь косит пехоту издалека. Кавалерия, если доскакала, сминает батарею в упор.',
    },
  };
  return { label, hint: hints[era][cls] };
}

function chargeHint(era: EraId): string {
  const flavor = ERAS[era];
  return `${flavor.chargeLabel}: удар с 2 гексов, если осталось не меньше ${CHARGE_COST} кл. хода. Атака ×${CHARGE_ATTACK}, после удара ход кончается. В лес так атаковать нельзя.`;
}

function terrainHint(army: Army): string | null {
  const label = terrainMoveHint(army);
  if (!label) return null;
  const forestCost = enterMoveCost(army, 'forest');
  const hillCost = enterMoveCost(army, 'hills');
  const bits: string[] = [];
  if (enterHaltsArmy(army, 'forest')) {
    bits.push(`Лес стоит ${forestCost} кл. хода, и сомкнутый конный строй там сразу останавливается.`);
  } else if (forestCost > 1) {
    bits.push(`Лес для коней стоит ${forestCost} кл. хода, но лёгкие могут идти дальше.`);
  }
  if (hillCost > 1) bits.push(`Холмы для тяжёлых коней стоят ${hillCost} кл. хода.`);
  return bits.join(' ') || label;
}

interface StatChip {
  id: string;
  label: string;
  hint: string;
  warn?: boolean;
}

function unitStatChips(id: UnitId, era: EraId): StatChip[] {
  const u = unitsFor(era)[id];
  const flavor = ERAS[era];
  const rps = beatsExplain(id, era);
  const chips: StatChip[] = [
    {
      id: 'attack',
      label: `Атака ${fmtStat(u.attack)}`,
      hint: 'Сила удара в ближнем бою. Чем выше, тем больше потерь у врага. 1 — обычный отряд, выше 1 — бьёт крепче.',
    },
    {
      id: 'defense',
      label: `Защита ${fmtStat(u.defense)}`,
      hint: 'Насколько крепко держит рукопашную. Чем выше, тем меньше своих потерь. 1 — обычный отряд.',
    },
    {
      id: 'speed',
      label: `Ход ${u.speed} кл.`,
      hint: 'Сколько гексов отряд проходит за ваш ход. В смешанном стеке все идут со скоростью самого медленного.',
    },
    { id: 'rps', label: rps.label, hint: rps.hint },
  ];
  if (u.charge) {
    chips.push({ id: 'charge', label: flavor.chargeLabel, hint: chargeHint(era) });
  }
  const range = unitRange(id, era);
  if (range > 0) {
    const hill = range + HILLS_VOLLEY_BONUS;
    chips.push({
      id: 'volley',
      label: `${flavor.volleyLabel} ${range} кл. · с холма ${hill}`,
      hint: `${flavor.volleyLabel} на ${range} гекс${range === 1 ? '' : range < 5 ? 'а' : 'ов'} с равнины и на ${hill} с холма. Клетку цели не занимает, один раз за ход. ${flavor.volleyHint}`,
    });
  }
  if (u.mounted && u.class === 'archer') {
    chips.push({
      id: 'kite',
      label: flavor.kiteLabel,
      hint: `${flavor.kiteLabel}: после выстрела можно уйти на оставшиеся клетки хода. Если в стеке есть пехота или ударная конница — отойти нельзя.`,
    });
  }
  const army = { [id]: 1 };
  const terrain = terrainMoveHint(army);
  const explain = terrainHint(army);
  if (terrain && explain) {
    chips.push({ id: 'terrain', label: terrain, hint: explain });
  }
  return chips;
}

function ExplainChips({ chips, prompt = false }: { chips: StatChip[]; prompt?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (chips.length === 0) return null;
  const active = chips.find((chip) => chip.id === open);
  return (
    <div className="explain-chips">
      <div className="chips">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`chip chip-explain${chip.warn ? ' warn' : ''}${open === chip.id ? ' selected' : ''}`}
            aria-expanded={open === chip.id}
            onClick={() => {
              haptic('light');
              setOpen((cur) => (cur === chip.id ? null : chip.id));
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {active ? (
        <p className="chip-hint">{active.hint}</p>
      ) : prompt ? (
        <p className="chip-hint muted">Нажмите характеристику, чтобы узнать, что это значит.</p>
      ) : null}
    </div>
  );
}

function turnsLabel(n: number): string {
  if (n === 1) return '1 ход';
  if (n >= 2 && n <= 4) return `${n} хода`;
  return `${n} ходов`;
}

function ArmyChips({ army, era }: { army: Army; era: EraId }) {
  const catalog = unitsFor(era);
  const parts = UNIT_IDS.filter((id) => (army[id] ?? 0) > 0);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((id) => (
        <span key={id} className="chip">
          {catalog[id].icon} {army[id]} {catalog[id].name}
        </span>
      ))}
    </>
  );
}

export default function GameScreen({ state, meId, viewerId, act, notify, fx }: Props) {
  const [selected, setSelected] = useState<Coord | null>(null);
  const [mode, setMode] = useState<PickMode>('none');
  const [moveFrom, setMoveFrom] = useState<Coord | null>(null);
  const [moveTarget, setMoveTarget] = useState<Coord | null>(null);
  const [moveCount, setMoveCount] = useState(1);
  const [moveUnit, setMoveUnit] = useState<UnitId | null>(null);
  const [supportKeys, setSupportKeys] = useState<string[]>([]);
  const [recruitCount, setRecruitCount] = useState(1);
  const [recruitUnit, setRecruitUnit] = useState<UnitId>(DEFAULT_UNIT);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [showTech, setShowTech] = useState(false);

  const me = state.players.find((p) => p.id === meId);
  const currentId = state.order[state.turnIndex];
  const current = state.players.find((p) => p.id === currentId);
  const isMyTurn = currentId === meId && state.phase === 'playing';
  const hotseat = state.settings.hotseat === true;
  const pendingSquare = state.pendingSquare ?? null;
  const canReplySquare = Boolean(pendingSquare && canAnswerSquare(state, viewerId));
  const era = eraOf(state.settings);
  const units = unitsFor(era);
  const eraInfo = ERAS[era];

  useEffect(() => {
    if (!isMyTurn) {
      setMode('none');
      setMoveFrom(null);
      setMoveTarget(null);
      setSheet(null);
    }
  }, [isMyTurn]);

  useEffect(() => {
    setMode('none');
    setMoveFrom(null);
    setMoveTarget(null);
    setSheet(null);
    setSelected(null);
    setShowTech(false);
  }, [meId]);

  const selectedTile = selected ? tileAt(state, selected.x, selected.y) : null;
  const fromTile = moveFrom ? tileAt(state, moveFrom.x, moveFrom.y) : null;
  const targetTile = moveTarget ? tileAt(state, moveTarget.x, moveTarget.y) : null;
  const fromWings = fromTile ? ensureWings(fromTile) : [];
  const fromKinds = fromTile
    ? armyUnitIds(fromTile.army).filter((id) => mobileCount(fromWings, id) > 0)
    : [];
  const previewArmy = fromTile
    ? moveUnit
      ? { [moveUnit]: fromTile.army[moveUnit] ?? 0 }
      : fromTile.army
    : {};
  const targetCount = targetTile ? armyCount(targetTile.army) : 0;
  const chargeTarget =
    fromTile != null &&
    targetTile != null &&
    hexDistance(fromTile, targetTile) === 2 &&
    targetTile.ownerId !== meId &&
    targetCount > 0 &&
    armyCanCharge(previewArmy) &&
    targetTile.terrain !== 'forest' &&
    chargePathOpen(state, fromTile, targetTile, meId);
  const moveMinMp = chargeTarget ? CHARGE_COST : 1;
  const fromCount = fromTile ? mobileCount(fromWings, moveUnit ?? undefined, moveMinMp) : 0;
  const takenWings = fromTile
    ? takeFromWings(fromWings, Math.min(moveCount, Math.max(fromCount, 0)), moveUnit ?? undefined, moveMinMp).taken
    : [];
  const movingArmy = wingsToArmy(takenWings);
  const mergeWarn =
    fromTile && targetTile && targetTile.ownerId === meId && armyCount(targetTile.army) > 0
      ? mixWarning(targetTile.army, movingArmy, era)
      : null;
  const terrainHalt =
    targetTile != null &&
    !chargeTarget &&
    takenWings.some((wing) => moveHaltsOnEnter(wing.army, targetTile.terrain, wing.movesLeft));
  const terrainCost =
    targetTile != null && takenWings.length > 0
      ? Math.max(...takenWings.map((wing) => spentMoveCost(wing.army, targetTile.terrain, wing.movesLeft)))
      : 1;
  const alreadyMarching = wingsAlreadyMarching(
    takenWings,
    fromTile?.commander ? COMMANDERS[fromTile.commander].speedBonus : 0,
    era,
  );
  const takenMpLabel = mpSpan(takenWings.map((wing) => wing.movesLeft));

  const income = useMemo(() => (me ? computeIncome(state, me.id) : null), [state, me]);
  const upkeep = useMemo(() => (me ? upkeepFor(state, me.id) : 0), [state, me]);

  const { highlighted, chargeHighlighted } = useMemo(() => {
    const move = new Set<string>();
    const charge = new Set<string>();
    if (!fromTile || mode === 'none') return { highlighted: move, chargeHighlighted: charge };
    if (mode === 'move') {
      if (fromTile.movesLeft < 1) return { highlighted: move, chargeHighlighted: charge };
      const moving = moveUnit ? { [moveUnit]: fromTile.army[moveUnit] ?? 0 } : fromTile.army;
      for (const t of walkReachable(state, fromTile, meId, 1, fromTile.routedTurns === 0)) {
        move.add(coordKey(t));
      }
      if (
        mobileCount(ensureWings(fromTile), moveUnit ?? undefined, CHARGE_COST) >= 1 &&
        fromTile.routedTurns === 0 &&
        armyCanCharge(moving)
      ) {
        for (const tile of state.tiles) {
          if (hexDistance(fromTile, tile) !== 2) continue;
          if (tile.ownerId === meId) continue;
          if (armyCount(tile.army) < 1) continue;
          if (tile.terrain === 'forest') continue;
          if (!TERRAIN[tile.terrain].passable) continue;
          if (!chargePathOpen(state, fromTile, tile, meId)) continue;
          charge.add(coordKey(tile));
        }
      }
      const highlighted = new Set<string>([...move, ...charge]);
      return { highlighted, chargeHighlighted: charge };
    }
    if (fromTile.routedTurns > 0) return { highlighted: move, chargeHighlighted: charge };
    const range = armyRange(fromTile.army, era, fromTile.terrain);
    for (const tile of state.tiles) {
      const dist = hexDistance(fromTile, tile);
      if (dist < 1 || dist > range) continue;
      if (tile.ownerId === meId) continue;
      if (armyCount(tile.army) < 1) continue;
      move.add(coordKey(tile));
    }
    return { highlighted: move, chargeHighlighted: charge };
  }, [state, fromTile, mode, meId, moveUnit]);

  const resetPick = () => {
    setMode('none');
    setMoveFrom(null);
    setMoveTarget(null);
    setMoveCount(1);
    setMoveUnit(null);
    setSupportKeys([]);
  };

  const run = async (action: GameAction) => {
    const result = await act(action);
    if (result.ok) hapticResult('success');
    return result;
  };

  const pick = (tile: Tile) => {
    haptic('light');
    if (mode === 'move' && fromTile && highlighted.has(coordKey(tile))) {
      const dist = hexDistance(fromTile, tile);
      const enemyFight = tile.ownerId !== meId && armyCount(tile.army) > 0;
      const wantCharge =
        dist === 2 &&
        enemyFight &&
        fromTile.routedTurns === 0 &&
        tile.terrain !== 'forest' &&
        chargePathOpen(state, fromTile, tile, meId) &&
        armyCanCharge(moveUnit ? { [moveUnit]: fromTile.army[moveUnit] ?? 0 } : fromTile.army);
      const available = mobileCount(
        ensureWings(fromTile),
        moveUnit ?? undefined,
        wantCharge ? CHARGE_COST : 1,
      );
      setMoveTarget({ x: tile.x, y: tile.y });
      setMoveCount(Math.max(1, available));
      setSupportKeys([]);
      return;
    }
    if (mode === 'shoot' && fromTile && highlighted.has(coordKey(tile))) {
      void run({ type: 'shoot', from: { x: fromTile.x, y: fromTile.y }, to: { x: tile.x, y: tile.y } });
      resetPick();
      setSelected({ x: fromTile.x, y: fromTile.y });
      return;
    }
    resetPick();
    setSheet(null);
    setSelected({ x: tile.x, y: tile.y });
  };

  const confirmMove = async () => {
    if (!fromTile || !targetTile) return;
    const from = { x: fromTile.x, y: fromTile.y };
    const to = { x: targetTile.x, y: targetTile.y };
    const supportFrom = supportKeys.map((key) => {
      const [x, y] = key.split(',').map(Number);
      return { x: x!, y: y! };
    });
    const result = await run({
      type: 'move',
      from,
      to,
      count: Math.min(moveCount, Math.max(fromCount, 1)),
      unit: moveUnit ?? undefined,
      supportFrom: supportFrom.length > 0 ? supportFrom : undefined,
    });
    if (result.ok) {
      resetPick();
      const lost = result.fx?.battle === 'lost' || result.fx?.battle === 'rout';
      setSelected(result.state?.pendingSquare || lost ? from : to);
    }
  };

  const maxRecruit = me ? maxAffordable(me.resources.gold, me.resources.iron, me.resources.food, recruitUnit) : 0;
  const recruitCost = UNITS[recruitUnit].cost;
  const hire = Math.min(recruitCount, maxRecruit);

  const canRecruitHere =
    selectedTile != null &&
    selectedTile.ownerId === meId &&
    (selectedTile.capitalOf === meId ||
      (selectedTile.building ? BUILDINGS[selectedTile.building].allowsRecruit : false));

  const canBuildHere =
    selectedTile != null &&
    selectedTile.ownerId === meId &&
    !selectedTile.building &&
    !selectedTile.construction &&
    TERRAIN[selectedTile.terrain].passable;

  const canAppointHere =
    canRecruitHere && selectedTile != null && armyCount(selectedTile.army) > 0 && !selectedTile.commander;

  const coveringAllies =
    fromTile && targetTile && targetCount > 0 && targetTile.ownerId !== meId
      ? allyStacksCovering(state, meId, targetTile, fromTile)
      : [];
  const selectedAllies = coveringAllies.filter((tile) => supportKeys.includes(coordKey(tile)));
  const coveringSupport = selectedAllies.reduce((army, tile) => mergeArmies(army, tile.army), {} as Army);
  const coveringCount = armyCount(coveringSupport);

  const battleForecast = (() => {
    if (!fromTile || !targetTile || !me) return null;
    if (targetCount === 0 || targetTile.ownerId === meId) return null;
    const defender = targetTile.ownerId ? state.players.find((p) => p.id === targetTile.ownerId) : undefined;
    const attacking = movingArmy;
    const charging =
      hexDistance(fromTile, targetTile) === 2 &&
      armyCanCharge(attacking) &&
      targetTile.terrain !== 'forest' &&
      chargePathOpen(state, fromTile, targetTile, meId);
    return battleForecastRatio(state, me, attacking, targetTile, defender, charging, coveringSupport);
  })();

  if (!me) {
    return (
      <div className="screen center">
        <p className="muted">Вы наблюдаете за партией {state.roomCode}</p>
      </div>
    );
  }

  return (
    <div className={`screen game${state.phase === 'finished' ? ' finished' : ''}`}>
      <header className="topbar">
        <div className="topbar-row">
          <span className="round">
            Раунд {state.round}/{state.maxRounds}
            {hotseat ? ' · сам с собой' : ''}
            {` · ${eraInfo.icon} ${eraInfo.name}`}
          </span>
          <span className="turn">
            <span className="dot" style={{ background: current?.color ?? '#888' }} />
            {hotseat ? `Ход: ${current?.name ?? '—'}` : isMyTurn ? 'Ваш ход' : `Ходит ${current?.name ?? '—'}`}
          </span>
        </div>
        <div className="resources">
          <span title="Золото">🪙 {me.resources.gold}{income ? <i className="delta"> +{income.gold}</i> : null}</span>
          <span title="Еда">🌾 {me.resources.food}
            {income ? <i className={income.food - upkeep >= 0 ? 'delta' : 'delta neg'}> {income.food - upkeep >= 0 ? '+' : ''}{income.food - upkeep}</i> : null}
          </span>
          <span title="Железо">🔩 {me.resources.iron}{income ? <i className="delta"> +{income.iron}</i> : null}</span>
          <span title="Действия" className="actions-left">⚡ {isMyTurn ? me.actionsLeft : '—'}</span>
        </div>
      </header>

      <MapBoard
        state={state}
        meId={meId}
        selected={selected}
        highlighted={highlighted}
        chargeHighlighted={chargeHighlighted}
        supportHighlighted={new Set(selectedAllies.map((tile) => coordKey(tile)))}
        highlightKind={mode === 'shoot' ? 'shoot' : 'move'}
        fx={fx}
        onPick={pick}
      />

      {state.phase !== 'finished' && (
        <>
      <div className="panel">
        {targetTile && fromTile && mode === 'move' ? (
          <div className="move-panel">
            <div className="panel-title">
              {chargeTarget
                ? 'Набег · −2 кл. хода · 1⚡'
                : terrainHalt
                  ? `${TERRAIN[targetTile.terrain].name} · −${terrainCost} кл. · стоп`
                  : alreadyMarching
                    ? `Ещё шаг · ${takenMpLabel} кл. · 0⚡`
                    : fromTile.movesLeft >= 2
                      ? `Шаг · запас ${takenMpLabel} кл. · 1⚡`
                      : 'Ход · 1 кл. · 1⚡'}
            </div>
            {fromKinds.length > 1 && (
              <div className="chips">
                <button
                  type="button"
                  className={`chip chip-pick${!moveUnit ? ' selected' : ''}`}
                  onClick={() => {
                    setMoveUnit(null);
                    setMoveCount(mobileCount(fromWings, undefined, moveMinMp));
                  }}
                >
                  Все
                </button>
                {fromKinds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`chip chip-pick${moveUnit === id ? ' selected' : ''}`}
                    onClick={() => {
                      setMoveUnit(id);
                      setMoveCount(Math.max(1, mobileCount(fromWings, id, moveMinMp)));
                    }}
                  >
                    {units[id].icon} {mobileCount(fromWings, id, moveMinMp)}
                  </button>
                ))}
              </div>
            )}
            <input
              type="range"
              min={1}
              max={Math.max(1, fromCount)}
              value={Math.min(moveCount, Math.max(1, fromCount))}
              onChange={(e) => setMoveCount(Number(e.target.value))}
            />
            <div className="row">
              <span>{moveCount} из {fromCount} отр.</span>
              {battleForecast != null && (
                <span className={battleForecast >= 1.2 ? 'good' : battleForecast >= 0.9 ? 'warn' : 'bad'}>
                  {coveringCount > 0 ? `Вместе ${moveCount + coveringCount} отр. · ` : ''}
                  {battleForecast.toFixed(2)}×
                </span>
              )}
            </div>
            {coveringAllies.length > 0 && (
              <div className="support-pick">
                <p className="muted small">Помощники рядом — отметьте, кто бьёт вместе (после удара они тоже выдыхаются):</p>
                <div className="chips">
                  {coveringAllies.map((tile) => {
                    const key = coordKey(tile);
                    const on = supportKeys.includes(key);
                    const n = armyCount(tile.army);
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`chip chip-pick${on ? ' selected' : ''}`}
                        onClick={() => {
                          haptic('light');
                          setSupportKeys((cur) => (on ? cur.filter((k) => k !== key) : [...cur, key]));
                        }}
                      >
                        {on ? '✓ ' : ''}
                        {n} отр. ({tile.x},{tile.y})
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {coveringCount > 0 && (
              <p className="muted small">В ударе участвуют {coveringCount} соседних отр. — силы складываются.</p>
            )}
            {coveringAllies.length > 0 && coveringCount === 0 && (
              <p className="muted small">Без помощников бьёт только выбранный отряд.</p>
            )}
            {fromTile &&
              targetTile &&
              targetCount > 0 &&
              targetTile.ownerId !== meId &&
              shouldOfferSquare(state, movingArmy, targetTile) && (
                <p className="muted small">
                  Оборона сможет встать в каре: конница почти не берёт строй, держать каре стоит 1⚡ за ход.
                </p>
              )}
            {targetTile?.square && (
              <p className="muted small">Цель стоит в каре: конница бьёт очень слабо, пехота отвечает так же скученно.</p>
            )}
            {mergeWarn && <p className="warn small">{mergeWarn}</p>}
            <div className="chips">
              <ArmyChips army={movingArmy} era={era} />
            </div>
            <div className="row">
              <button className="btn primary grow" onClick={confirmMove}>
                {chargeTarget
                  ? 'Набег'
                  : targetCount > 0 && targetTile.ownerId !== meId
                    ? coveringCount > 0
                      ? 'Бить вместе'
                      : 'В атаку'
                    : 'Занять'}
              </button>
              <button className="btn" onClick={resetPick}>
                Отмена
              </button>
            </div>
          </div>
        ) : mode === 'shoot' ? (
          <p className="muted center-text">
            Выберите цель для {eraInfo.volleyLabel.toLowerCase()} (до {fromTile ? armyRange(fromTile.army, era, fromTile.terrain) : 2} кл.). {eraInfo.volleyHint}
          </p>
        ) : selectedTile ? (
          <TileDetails
            state={state}
            tile={selectedTile}
            meId={meId}
            isMyTurn={isMyTurn}
            canRecruitHere={canRecruitHere}
            canBuildHere={canBuildHere}
            canAppointHere={canAppointHere}
            onStartMove={() => {
              if (selectedTile.routedTurns > 0) {
                notify('Отступающим отрядом нельзя управлять');
                return;
              }
              if (squarePinned(state, selectedTile)) {
                notify('Каре не разойти, пока рядом вражеская конница');
                return;
              }
              if (mobileCount(ensureWings(selectedTile)) < 1) {
                notify('Эти войска уже ходили в этот ход');
                return;
              }
              setMoveFrom({ x: selectedTile.x, y: selectedTile.y });
              setMoveUnit(null);
              setSupportKeys([]);
              setMode('move');
              const { min, max } = wingMoveRange(selectedTile);
              notify(
                armyRidesHorses(selectedTile.army)
                  ? terrainMoveHint(selectedTile.army) ?? 'Выберите соседний гекс'
                  : max >= 2
                    ? min !== max
                      ? `Соседний гекс · запас хода ${min}–${max} кл. у разных отрядов`
                      : `Соседний гекс, потом ещё шаг за ту же 1⚡ (${max} кл.)`
                    : 'Выберите соседний гекс',
              );
            }}
            onStartShoot={() => {
              if (selectedTile.shotsLeft < 1) {
                notify(`Этот отряд уже ${eraInfo.volleyLabel === 'Залп' ? 'дал залп' : 'стрелял'} в этот ход`);
                return;
              }
              const bonus = selectedTile.commander ? COMMANDERS[selectedTile.commander].speedBonus : 0;
              if (tileHasMarched(selectedTile, era, bonus) && armyHasHeavyArtillery(selectedTile.army, era)) {
                notify('Тяжёлая артиллерия после хода не стреляет');
                return;
              }
              setMoveFrom({ x: selectedTile.x, y: selectedTile.y });
              setMode('shoot');
              const weak =
                tileHasMarched(selectedTile, era, bonus)
                  ? ` Огонь слабее (−${Math.round((1 - MOVED_VOLLEY) * 100)}%) после хода.`
                  : '';
              notify(
                (eraInfo.volleyHint.includes('лес')
                  ? `Выберите цель для ${eraInfo.volleyLabel.toLowerCase()}`
                  : 'Выберите цель') + weak,
              );
            }}
            onOpenRecruit={() => {
              setRecruitCount(1);
              setSheet('recruit');
            }}
            onOpenBuild={() => setSheet('build')}
            onOpenCommander={() => setSheet('commander')}
            onFormSquare={() => {
              void run({ type: 'formSquare', at: { x: selectedTile.x, y: selectedTile.y } });
            }}
            onBreakSquare={() => {
              void run({ type: 'breakSquare', at: { x: selectedTile.x, y: selectedTile.y } });
            }}
          />
        ) : (
          <p className="muted center-text">Выберите клетку на карте</p>
        )}
      </div>

      <div className="log">
        {state.log.slice(-1).map((entry, i) => (
          <div key={i} className="log-line">
            <b>{entry.round}</b> {entry.text}
          </div>
        ))}
      </div>

      <footer className="bottombar">
        <button className="btn" onClick={() => setShowTech(true)}>
          🔬 Технологии
        </button>
        <button className="btn primary grow" disabled={!isMyTurn || Boolean(pendingSquare)} onClick={() => run({ type: 'endTurn' })}>
          Завершить ход
        </button>
      </footer>
        </>
      )}

      {sheet === 'recruit' && selectedTile && (
        <RecruitSheet
          tile={selectedTile}
          gold={me.resources.gold}
          iron={me.resources.iron}
          food={me.resources.food}
          recruitUnit={recruitUnit}
          setRecruitUnit={setRecruitUnit}
          recruitCount={recruitCount}
          setRecruitCount={setRecruitCount}
          maxRecruit={maxRecruit}
          hire={hire}
          recruitCost={recruitCost}
          disabled={!isMyTurn}
          era={era}
          onRecruit={() => {
            void run({
              type: 'recruit',
              at: { x: selectedTile.x, y: selectedTile.y },
              count: hire,
              unit: recruitUnit,
            }).then((result) => {
              if (result.ok) setSheet(null);
            });
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet === 'build' && selectedTile && (
        <BuildSheet
          era={era}
          gold={me.resources.gold}
          iron={me.resources.iron}
          disabled={!isMyTurn}
          onBuild={(building) => {
            void run({ type: 'build', at: { x: selectedTile.x, y: selectedTile.y }, building }).then((result) => {
              if (result.ok) setSheet(null);
            });
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet === 'commander' && selectedTile && (
        <CommanderSheet
          era={era}
          gold={me.resources.gold}
          iron={me.resources.iron}
          disabled={!isMyTurn}
          onAppoint={(commander) => {
            void run({ type: 'appoint', at: { x: selectedTile.x, y: selectedTile.y }, commander }).then((result) => {
              if (result.ok) setSheet(null);
            });
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {showTech && (
        <TechModal
          era={era}
          player={me}
          isMyTurn={isMyTurn}
          onResearch={(tech) => run({ type: 'research', tech })}
          onClose={() => setShowTech(false)}
        />
      )}

      {pendingSquare && (
        <div className="overlay center">
          <div className="overlay-card square-card">
            <div className="hero-icon">⬛</div>
            <h2>Каре</h2>
            {canReplySquare ? (
              <>
                <p>
                  Вражеская конница идёт в удар. Встать в каре? Конница будет бить очень слабо, пехота тоже ответит
                  скученно. Держать строй стоит 1⚡ каждый ваш ход. Разойти каре нельзя, пока рядом вражеская конница.
                </p>
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn primary grow" onClick={() => run({ type: 'squareReply', form: true })}>
                    Встать в каре
                  </button>
                  <button className="btn grow" onClick={() => run({ type: 'squareReply', form: false })}>
                    Встретить в линии
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">Оборона решает, вставать ли в каре.</p>
            )}
          </div>
        </div>
      )}

      {state.phase === 'finished' && (
        <div className="overlay center">
          <div className="overlay-card victory">
            <div className="hero-icon">{state.winnerId === meId ? '👑' : '🏳️'}</div>
            <h2>{state.winnerId === meId ? 'Победа!' : `Победил ${state.players.find((p) => p.id === state.winnerId)?.name ?? '—'}`}</h2>
            <p className="muted">Партия {state.roomCode} · раунд {state.round}</p>
          </div>
        </div>
      )}
    </div>
  );
}

interface DetailsProps {
  state: GameState;
  tile: Tile;
  meId: string;
  isMyTurn: boolean;
  canRecruitHere: boolean;
  canBuildHere: boolean;
  canAppointHere: boolean;
  onStartMove: () => void;
  onStartShoot: () => void;
  onOpenRecruit: () => void;
  onOpenBuild: () => void;
  onOpenCommander: () => void;
  onFormSquare: () => void;
  onBreakSquare: () => void;
}

function TileDetails({
  state,
  tile,
  meId,
  isMyTurn,
  canRecruitHere,
  canBuildHere,
  canAppointHere,
  onStartMove,
  onStartShoot,
  onOpenRecruit,
  onOpenBuild,
  onOpenCommander,
  onFormSquare,
  onBreakSquare,
}: DetailsProps) {
  const era = eraOf(state.settings);
  const buildings = buildingsFor(era);
  const commanders = commandersFor(era);
  const eraInfo = ERAS[era];
  const owner = tile.ownerId ? state.players.find((p) => p.id === tile.ownerId) : null;
  const terrain = TERRAIN[tile.terrain];
  const isMine = tile.ownerId === meId;
  const count = armyCount(tile.army);
  const archers = armyCount(archerArmy(tile.army, era));
  const range = armyRange(tile.army, era, tile.terrain);
  const pinned = squarePinned(state, tile);
  const marched = tileHasMarched(tile, era, tile.commander ? COMMANDERS[tile.commander].speedBonus : 0);
  const heavyGunMoved = marched && armyHasHeavyArtillery(tile.army, era);
  const canShoot = tile.routedTurns < 1 && tile.shotsLeft > 0 && !heavyGunMoved;
  const canMarch = tile.routedTurns < 1 && mobileCount(ensureWings(tile)) > 0 && !pinned;
  const { min: minMp, max: maxMp } = wingMoveRange(tile);
  const canSquare = era === 'napoleonic' && isMine && isMyTurn && canFormSquare(tile) && !tile.square;

  return (
    <div>
      <div className="panel-title">
        {terrain.name}
        {tile.capitalOf ? ' · столица' : ''}
      </div>
      <div className="chips">
        <span className="chip">{owner ? `Владелец: ${owner.name}` : 'Ничья земля'}</span>
        {count > 0 && <span className="chip">Всего: {count}</span>}
        {isMine && isMyTurn && count > 0 && (
          <span className="chip">
            {maxMp < 1
              ? 'Ход исчерпан'
              : minMp !== maxMp
                ? `Ход ${minMp}–${maxMp} кл.`
                : `Ход ${maxMp} кл.`}
          </span>
        )}
        <ArmyChips army={tile.army} era={era} />
        {terrain.defenseBonus > 0 && (
          <span className="chip">Ближний +{Math.round(terrain.defenseBonus * 100)}%</span>
        )}
        {terrain.missileCover > 0 && (
          <span className="chip">От стрел +{Math.round(terrain.missileCover * 100)}%</span>
        )}
        {tile.building && (
          <span className="chip">
            {buildings[tile.building].icon} {buildings[tile.building].name}
            {buildings[tile.building].defenseBonus > 0
              ? ` · ближний +${Math.round(buildings[tile.building].defenseBonus * 100)}%`
              : ''}
          </span>
        )}
        {tile.construction && (
          <span className="chip">
            🛠️ {buildings[tile.construction.building].name} · ещё {turnsLabel(tile.construction.turnsLeft)}
          </span>
        )}
        {tile.commander && (
          <span className="chip">
            {commanders[tile.commander].icon} {commanders[tile.commander].name}
          </span>
        )}
        {tile.routedTurns > 0 && <span className="chip">💨 Бегство {tile.routedTurns} х.</span>}
        {tile.square && (
          <span className={`chip${pinned ? ' warn' : ''}`}>
            {pinned ? '⬛ Каре · конница рядом' : '⬛ Каре · 1⚡ за ход'}
          </span>
        )}
      </div>
      {isMine && (
        <ExplainChips
          key={`${tile.x},${tile.y}`}
          chips={[
            ...(armyUnitIds(tile.army).length > 1
              ? [
                  {
                    id: 'mix',
                    warn: true,
                    label: `Смешанный строй · ход ${armySpeed(tile.army, era)}`,
                    hint: 'Разные рода в одном стеке идут со скоростью самого медленного. Набег и отход после залпа работают, только если умеют все в стеке.',
                  },
                ]
              : []),
            ...(terrainMoveHint(tile.army)
              ? [
                  {
                    id: 'terrain',
                    label: terrainMoveHint(tile.army)!,
                    hint: terrainHint(tile.army) ?? terrainMoveHint(tile.army)!,
                  },
                ]
              : []),
            ...(armyCanCharge(tile.army) && maxMp >= 2
              ? [{ id: 'charge', label: eraInfo.chargeLabel, hint: chargeHint(era) }]
              : []),
          ]}
        />
      )}

      {!isMyTurn && <p className="muted">Дождитесь своего хода.</p>}
      {!isMine && state.phase === 'playing' && !canWatchTile(state, meId, tile) && (
        <p className="muted">Вне поля зрения: чужие войска здесь не видны.</p>
      )}

      {isMyTurn && isMine && (
        <div className="action-grid">
          {count > 0 && (
            <button className="action-btn action-move" onClick={onStartMove} disabled={!canMarch}>
              <span className="action-icon">🚶</span>
              <span className="action-label">Ход</span>
              <span className="action-sub">
                {tile.routedTurns > 0
                  ? 'в бегстве'
                  : !canMarch
                  ? pinned
                    ? 'каре держит строй'
                    : 'уже ходили'
                  : armyCanCharge(tile.army) && maxMp >= 2
                    ? minMp !== maxMp
                      ? `шаг / удар · ${minMp}–${maxMp} кл.`
                      : `шаг / удар · ${maxMp} кл.`
                    : maxMp >= 2
                      ? minMp !== maxMp
                        ? `по 1 кл. · запас ${minMp}–${maxMp}`
                        : `по 1 кл. · запас ${maxMp}`
                      : '1 кл. · 1⚡'}
              </span>
            </button>
          )}
          {archers > 0 && (
            <button className="action-btn action-shoot" onClick={onStartShoot} disabled={!canShoot}>
              <span className="action-icon">{era === 'napoleonic' ? '🔫' : '🏹'}</span>
              <span className="action-label">{eraInfo.volleyLabel}</span>
              <span className="action-sub">
                {tile.routedTurns > 0
                  ? 'в бегстве'
                  : heavyGunMoved
                    ? 'после хода нельзя'
                    : tile.shotsLeft < 1
                      ? 'уже стреляли'
                      : marched
                        ? `${archers} · слабее после хода`
                        : armyCanKite(tile.army)
                          ? `${archers} · ${eraInfo.kiteLabel.toLowerCase()}`
                          : `${archers} · ${range} кл.`}
              </span>
            </button>
          )}
          {canRecruitHere && (
            <button className="action-btn action-recruit" onClick={onOpenRecruit}>
              <span className="action-icon">⚔️</span>
              <span className="action-label">Найм</span>
              <span className="action-sub">столица и {buildings.barracks.name.toLowerCase()}</span>
            </button>
          )}
          {canBuildHere && (
            <button className="action-btn action-build" onClick={onOpenBuild}>
              <span className="action-icon">🏗️</span>
              <span className="action-label">Стройка</span>
              <span className="action-sub">несколько ходов</span>
            </button>
          )}
          {canAppointHere && (
            <button className="action-btn action-appoint" onClick={onOpenCommander}>
              <span className="action-icon">🎖️</span>
              <span className="action-label">Командир</span>
              <span className="action-sub">усиливает стек</span>
            </button>
          )}
          {canSquare && (
            <button className="action-btn" onClick={onFormSquare}>
              <span className="action-icon">⬛</span>
              <span className="action-label">Каре</span>
              <span className="action-sub">1⚡ · против конницы</span>
            </button>
          )}
          {tile.square && (
            <button className="action-btn" onClick={onBreakSquare} disabled={pinned}>
              <span className="action-icon">⬜</span>
              <span className="action-label">Разойти</span>
              <span className="action-sub">{pinned ? 'конница рядом' : 'свободно'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface RecruitSheetProps {
  tile: Tile;
  gold: number;
  iron: number;
  food: number;
  recruitUnit: UnitId;
  setRecruitUnit: (id: UnitId) => void;
  recruitCount: number;
  setRecruitCount: (n: number) => void;
  maxRecruit: number;
  hire: number;
  recruitCost: { gold: number; food: number; iron: number };
  disabled: boolean;
  era: EraId;
  onRecruit: () => void;
  onClose: () => void;
}

function RecruitSheet({
  tile,
  gold,
  iron,
  food,
  recruitUnit,
  setRecruitUnit,
  recruitCount,
  setRecruitCount,
  maxRecruit,
  hire,
  recruitCost,
  disabled,
  era,
  onRecruit,
  onClose,
}: RecruitSheetProps) {
  const catalog = unitsFor(era);
  const flavor = ERAS[era];
  const mix = mixWarning(tile.army, { [recruitUnit]: 1 }, era);
  const picked = catalog[recruitUnit];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card sheet" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">Найм войск</div>
        <p className="muted unit-hint-show">{flavor.rpsHint}</p>
        <div className="unit-grid">
          {UNIT_IDS.map((id) => {
            const info = catalog[id];
            const canBuy = maxAffordable(gold, iron, food, id) > 0;
            return (
              <button
                key={id}
                type="button"
                className={`unit-pick unit-pick-${info.class}${info.mounted ? ' unit-pick-mounted' : ''}${info.shot === 'musket' && info.class === 'infantry' ? ' unit-pick-musket' : ''}${recruitUnit === id ? ' selected' : ''}`}
                title={info.name}
                onClick={() => setRecruitUnit(id)}
              >
                <span className="unit-pick-icon" aria-hidden>
                  {info.icon}
                </span>
                <span className="unit-pick-name">{info.short}</span>
                <span className={`unit-pick-cost${canBuy ? '' : ' bad'}`}>
                  🪙{info.cost.gold}
                  {info.cost.iron ? ` 🔩${info.cost.iron}` : ''}
                </span>
              </button>
            );
          })}
        </div>
        <div className="unit-stats">
          <div className="unit-stats-name">
            {picked.icon} {picked.name}
          </div>
          <p className="muted unit-stats-desc">{picked.description}</p>
          <ExplainChips key={recruitUnit} prompt chips={unitStatChips(recruitUnit, era)} />
        </div>
        {mix && <p className="warn small">{mix} Лучше вывести гарнизон, затем нанять на пустую клетку.</p>}
        {maxRecruit === 0 ? (
          <p className="muted">
            Не хватает ресурсов на {picked.name} (🪙{recruitCost.gold}
            {recruitCost.iron ? ` 🔩${recruitCost.iron}` : ''}).
          </p>
        ) : (
          <>
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={hire <= 1}
                onClick={() => setRecruitCount(Math.max(1, hire - 1))}
              >
                −
              </button>
              <input
                type="range"
                min={1}
                max={maxRecruit}
                value={Math.min(recruitCount, maxRecruit)}
                onChange={(e) => setRecruitCount(Number(e.target.value))}
              />
              <button
                type="button"
                className="btn"
                disabled={hire >= maxRecruit}
                onClick={() => setRecruitCount(Math.min(maxRecruit, hire + 1))}
              >
                +
              </button>
            </div>
            <button className="btn primary full" disabled={disabled} onClick={onRecruit}>
              Нанять {hire} × {picked.icon} {picked.name} · 🪙
              {hire * recruitCost.gold}
              {recruitCost.iron ? ` 🔩${hire * recruitCost.iron}` : ''}
            </button>
          </>
        )}
        <button className="btn full" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

interface BuildSheetProps {
  era: EraId;
  gold: number;
  iron: number;
  disabled: boolean;
  onBuild: (building: BuildingType) => void;
  onClose: () => void;
}

function BuildSheet({ era, gold, iron, disabled, onBuild, onClose }: BuildSheetProps) {
  const catalog = buildingsFor(era);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card sheet" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">Строительство</div>
        <p className="muted">Постройка появляется через несколько ваших ходов.</p>
        <div className="build-grid">
          {(Object.keys(catalog) as BuildingType[]).map((key) => {
            const info = catalog[key];
            const affordable = gold >= (info.cost.gold ?? 0) && iron >= (info.cost.iron ?? 0);
            return (
              <button
                key={key}
                className="build-btn"
                disabled={!affordable || disabled}
                onClick={() => onBuild(key)}
              >
                <span className="build-icon">{info.icon}</span>
                <span className="build-name">{info.name}</span>
                <span className="build-cost">
                  🪙{info.cost.gold ?? 0}
                  {info.cost.iron ? ` 🔩${info.cost.iron}` : ''} · {turnsLabel(info.buildTurns)}
                </span>
                <span className="build-desc">{info.description}</span>
              </button>
            );
          })}
        </div>
        <button className="btn full" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

interface CommanderSheetProps {
  era: EraId;
  gold: number;
  iron: number;
  disabled: boolean;
  onAppoint: (commander: CommanderId) => void;
  onClose: () => void;
}

function CommanderSheet({ era, gold, iron, disabled, onAppoint, onClose }: CommanderSheetProps) {
  const catalog = commandersFor(era);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card sheet" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">Командир стека</div>
        <p className="muted">Один командир на стек. Ходит вместе со всем отрядом и усиливает его.</p>
        <div className="build-grid">
          {COMMANDER_IDS.map((id) => {
            const info = catalog[id];
            const affordable = gold >= info.cost.gold && iron >= info.cost.iron;
            return (
              <button
                key={id}
                className="build-btn"
                disabled={!affordable || disabled}
                onClick={() => onAppoint(id)}
              >
                <span className="build-icon">{info.icon}</span>
                <span className="build-name">{info.name}</span>
                <span className="build-cost">
                  🪙{info.cost.gold} 🔩{info.cost.iron}
                </span>
                <span className="build-desc">{info.description}</span>
              </button>
            );
          })}
        </div>
        <button className="btn full" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}
