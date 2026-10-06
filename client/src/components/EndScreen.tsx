import { useMemo, useState } from 'react';
import { rankPlayers, scoreOf, totalArmy } from '@tge/shared';
import type { GameState, HistoryPoint, Player } from '@tge/shared';

interface Props {
  state: GameState;
  meId: string;
  viewerId: string;
  hotseat: boolean;
  onExit: () => void;
  onRematch: () => void;
}

type Tab = 'results' | 'chart' | 'armies' | 'records';
type Metric = 'score' | 'army' | 'tiles' | 'income';

const TABS: { id: Tab; label: string }[] = [
  { id: 'results', label: 'Итоги' },
  { id: 'chart', label: 'График' },
  { id: 'armies', label: 'Армии и земли' },
  { id: 'records', label: 'Рекорды' },
];

const METRICS: { id: Metric; label: string }[] = [
  { id: 'score', label: 'Очки' },
  { id: 'army', label: 'Армия' },
  { id: 'tiles', label: 'Клетки' },
  { id: 'income', label: 'Доход 🪙' },
];

/** Экран конца партии: итоги, график очков, армии и земли, рекорды. */
export default function EndScreen({ state, meId, viewerId, hotseat, onExit, onRematch }: Props) {
  const [tab, setTab] = useState<Tab>('results');
  const ranked = useMemo(() => rankPlayers(state), [state]);
  const winner = state.players.find((p) => p.id === state.winnerId);
  const iWon = !hotseat && state.winnerId === meId;

  return (
    <div className="overlay center end-screen">
      <div className="overlay-card end-card" onClick={(e) => e.stopPropagation()}>
        <div className="hero-icon">{iWon ? '👑' : '🏁'}</div>
        <h2>{iWon ? 'Победа!' : winner ? `Победил ${winner.name}` : 'Партия окончена'}</h2>
        <p className="muted small">
          Партия {state.roomCode} · раунд {Math.min(state.round, state.maxRounds)}
        </p>

        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={`tab${tab === t.id ? ' selected' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="end-body">
          {tab === 'results' && <Results state={state} ranked={ranked} meId={meId} hotseat={hotseat} />}
          {tab === 'chart' && <ChartTab state={state} />}
          {tab === 'armies' && <Armies state={state} />}
          {tab === 'records' && <Records state={state} />}
        </div>

        <div className="row end-actions">
          <button className="btn grow" onClick={onExit}>
            В меню
          </button>
          {state.players.some((p) => p.id === viewerId) && (
            <button className="btn primary grow" onClick={onRematch}>
              {state.rematchCode ? 'К реваншу' : 'Реванш'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Results({ state, ranked, meId, hotseat }: { state: GameState; ranked: Player[]; meId: string; hotseat: boolean }) {
  return (
    <div className="results">
      {ranked.map((p, i) => (
        <div key={p.id} className="result-row">
          <span className="result-place">{i + 1}</span>
          <span className="dot" style={{ background: p.color }} />
          <span className="grow left">
            {p.id === state.winnerId ? '👑 ' : p.alliedWinner ? '🤝 ' : ''}
            {p.name}
            {!hotseat && p.id === meId ? ' (вы)' : ''}
          </span>
          <span className="result-score">
            {state.settings.mode === 'wargame'
              ? `🎯 ${p.stats.squadsKilled} отр.${p.alive ? '' : ` · разбит на ${p.deadRound ?? '?'} р.`}`
              : p.alive
                ? `${scoreOf(state, p.id)} очк.`
                : `пал на ${p.deadRound ?? '?'} р.`}
          </span>
        </div>
      ))}
      {ranked.some((p) => p.alliedWinner) && <p className="muted small">🤝 — союзник-победитель</p>}
    </div>
  );
}

function ChartTab({ state }: { state: GameState }) {
  const [metric, setMetric] = useState<Metric>('score');
  return (
    <div>
      <div className="chips">
        {METRICS.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`chip chip-pick${metric === m.id ? ' selected' : ''}`}
            onClick={() => setMetric(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <HistoryChart state={state} metric={metric} />
    </div>
  );
}

/** Во время партии: свой график (очки, армия, клетки, доход) и личные счётчики. */
export function StatsSheet({ state, me, onClose }: { state: GameState; me: Player; onClose: () => void }) {
  const [metric, setMetric] = useState<Metric>('score');
  const s = me.stats;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card sheet" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">📈 Ваша держава</div>
        <div className="chips">
          {METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`chip chip-pick${metric === m.id ? ' selected' : ''}`}
              onClick={() => setMetric(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <HistoryChart state={state} metric={metric} />
        <div className="chips">
          <span className="chip">Побед {s.battlesWon}</span>
          <span className="chip">Поражений {s.battlesLost}</span>
          {state.settings.mode === 'wargame' && (
            <span className="chip">
              Отрядов уничтожено {s.squadsKilled} · потеряно {s.squadsLost}
            </span>
          )}
          <span className="chip">Выбито {s.unitsKilled}</span>
          <span className="chip">Потеряно {s.unitsLost}</span>
          <span className="chip">Захвачено клеток {s.tilesCaptured}</span>
          <span className="chip">Построено {s.buildingsBuilt}</span>
        </div>
        <button className="btn full" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

const CHART_W = 300;
const CHART_H = 170;
const PAD = { l: 30, r: 10, t: 10, b: 20 };

/** График по раундам без библиотек: линия на державу. Во время игры в истории только ряд самого игрока. */
export function HistoryChart({ state, metric }: { state: GameState; metric: Metric }) {
  const history: HistoryPoint[] = state.history ?? [];
  const players = state.players.filter((p) => history.some((h) => h.players[p.id]));
  if (history.length < 1 || players.length === 0) {
    return <p className="muted small">График появится после первого завершённого раунда.</p>;
  }
  const value = (h: HistoryPoint, id: string) => h.players[id]?.[metric];
  let max = 1;
  for (const h of history) for (const p of players) max = Math.max(max, value(h, p.id) ?? 0);
  const rounds = history.map((h) => h.round);
  const minRound = Math.min(...rounds);
  const maxRound = Math.max(...rounds);
  const x = (round: number) =>
    PAD.l + (maxRound === minRound ? (CHART_W - PAD.l - PAD.r) / 2 : ((round - minRound) / (maxRound - minRound)) * (CHART_W - PAD.l - PAD.r));
  const y = (v: number) => CHART_H - PAD.b - (v / max) * (CHART_H - PAD.t - PAD.b);
  const ticks = [0, 0.5, 1].map((k) => Math.round(max * k));

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="history-chart" role="img" aria-label="График по раундам">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={CHART_W - PAD.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={PAD.l - 4} y={y(t) + 3} textAnchor="end" className="chart-label">
              {t}
            </text>
          </g>
        ))}
        <text x={PAD.l} y={CHART_H - 4} className="chart-label">
          {minRound}
        </text>
        <text x={CHART_W - PAD.r} y={CHART_H - 4} textAnchor="end" className="chart-label">
          раунд {maxRound}
        </text>
        {players.map((p) => {
          const pts = history
            .map((h) => {
              const v = value(h, p.id);
              return v == null ? null : `${x(h.round).toFixed(1)},${y(v).toFixed(1)}`;
            })
            .filter((s): s is string => s != null);
          if (pts.length === 0) return null;
          return (
            <g key={p.id}>
              {pts.length > 1 && <polyline points={pts.join(' ')} fill="none" stroke={p.color} strokeWidth={2.2} strokeLinejoin="round" />}
              {pts.map((pt, i) => {
                const [cx, cy] = pt.split(',');
                return <circle key={i} cx={cx} cy={cy} r={i === pts.length - 1 ? 3.4 : 1.8} fill={p.color} />;
              })}
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">
        {players.map((p) => {
          const last = [...history].reverse().find((h) => value(h, p.id) != null);
          return (
            <span key={p.id} className="chart-legend-item">
              <span className="dot" style={{ background: p.color }} /> {p.name}
              <b> {last ? value(last, p.id) : '—'}</b>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Bars({ title, rows }: { title: string; rows: { player: Player; value: number; label?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bars">
      <div className="setting-label">{title}</div>
      {rows.map(({ player, value, label }) => (
        <div key={player.id} className="bar-row">
          <span className="bar-name">{player.name}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(value / max) * 100}%`, background: player.color }} />
          </span>
          <span className="bar-value">{label ?? value}</span>
        </div>
      ))}
    </div>
  );
}

function Armies({ state }: { state: GameState }) {
  const players = state.players;
  const tiles = (id: string) => state.tiles.reduce((n, t) => (t.ownerId === id ? n + 1 : n), 0);
  return (
    <div className="stat-bars">
      <Bars title="Клетки" rows={players.map((player) => ({ player, value: tiles(player.id) }))} />
      <Bars title="Армия к концу" rows={players.map((player) => ({ player, value: totalArmy(state, player.id) }))} />
      <Bars
        title="Убито отрядов"
        rows={players.map((player) => ({ player, value: player.stats.unitsKilled }))}
      />
      <Bars
        title="Потеряно отрядов"
        rows={players.map((player) => ({ player, value: player.stats.unitsLost }))}
      />
      <Bars title="Построено" rows={players.map((player) => ({ player, value: player.stats.buildingsBuilt }))} />
    </div>
  );
}

function best(players: Player[], pick: (p: Player) => number): { player: Player; value: number } | null {
  let top: { player: Player; value: number } | null = null;
  for (const player of players) {
    const value = pick(player);
    if (value > 0 && (!top || value > top.value)) top = { player, value };
  }
  return top;
}

function Records({ state }: { state: GameState }) {
  const name = (id: string | null | undefined) => state.players.find((p) => p.id === id)?.name ?? 'Ничья земля';
  const rec = state.records ?? {};
  const wins = best(state.players, (p) => p.stats.battlesWon);
  const kills = best(state.players, (p) => p.stats.unitsKilled);
  const captures = best(state.players, (p) => p.stats.tilesCaptured);
  const builder = best(state.players, (p) => p.stats.buildingsBuilt);
  const lucky = best(state.players, (p) => p.stats.eventsGood);
  const unlucky = best(state.players, (p) => p.stats.eventsBad);
  const rows: { icon: string; title: string; text: string }[] = [];
  if (rec.biggestBattle) {
    rows.push({
      icon: '💥',
      title: 'Крупнейшая битва',
      text: `${name(rec.biggestBattle.attackerId)} против ${name(rec.biggestBattle.defenderId)} · ${rec.biggestBattle.units} отр. · раунд ${rec.biggestBattle.round}`,
    });
  }
  if (rec.firstBlood) {
    rows.push({
      icon: '🩸',
      title: 'Первая кровь',
      text: `${name(rec.firstBlood.attackerId)} напал на ${name(rec.firstBlood.defenderId)} · раунд ${rec.firstBlood.round}`,
    });
  }
  if (wins) rows.push({ icon: '🏅', title: 'Больше всех побед в боях', text: `${wins.player.name} · ${wins.value}` });
  if (kills) rows.push({ icon: '⚔️', title: 'Больше всех выбито отрядов', text: `${kills.player.name} · ${kills.value}` });
  if (captures) rows.push({ icon: '🗺️', title: 'Больше всех захвачено клеток', text: `${captures.player.name} · ${captures.value}` });
  if (builder) rows.push({ icon: '🏗️', title: 'Главный строитель', text: `${builder.player.name} · ${builder.value}` });
  if (lucky) rows.push({ icon: '🍀', title: 'Любимец судьбы', text: `${lucky.player.name} · удачных событий: ${lucky.value}` });
  if (unlucky) rows.push({ icon: '🌩️', title: 'Не везло', text: `${unlucky.player.name} · неудач: ${unlucky.value}` });
  if (rows.length === 0) return <p className="muted small">Битв и событий не было — рекордов нет.</p>;
  return (
    <div className="records">
      {rows.map((row) => (
        <div key={row.title} className="record-row">
          <span className="record-icon">{row.icon}</span>
          <div className="left">
            <div className="record-title">{row.title}</div>
            <div className="muted small">{row.text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
