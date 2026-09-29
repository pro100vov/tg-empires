import { TRUCE_ROUNDS, relationOf } from '@tge/shared';
import type { GameAction, GameState } from '@tge/shared';

interface Props {
  state: GameState;
  meId: string;
  act: (action: GameAction) => Promise<{ ok: boolean }>;
  onClose: () => void;
}

/** Дипломатия: статус с каждой державой, предложения перемирия и союза, разрыв. */
export default function DiplomacySheet({ state, meId, act, onClose }: Props) {
  const others = state.players.filter((p) => p.id !== meId);
  const incoming = state.proposals.filter((p) => p.to === meId);
  const name = (id: string) => state.players.find((p) => p.id === id)?.name ?? '—';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card sheet" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">🤝 Дипломатия</div>

        {incoming.map((p) => (
          <div key={p.id} className="dip-incoming">
            <div>
              <b>{name(p.from)}</b> предлагает {p.kind === 'truce' ? `перемирие на ${p.rounds} р.` : 'союз'}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn primary grow" onClick={() => void act({ type: 'acceptProposal', id: p.id })}>
                Принять
              </button>
              <button className="btn grow" onClick={() => void act({ type: 'declineProposal', id: p.id })}>
                Отклонить
              </button>
            </div>
          </div>
        ))}

        {others.length === 0 && <p className="muted small">Других держав нет.</p>}
        {others.map((p) => {
          const rel = relationOf(state, meId, p.id);
          const outgoing = state.proposals.find((x) => x.from === meId && x.to === p.id);
          const waiting = state.proposals.some((x) => x.from === p.id && x.to === meId);
          let status = '⚔️ война';
          if (rel?.kind === 'truce') status = `🕊️ перемирие до раунда ${rel.until}`;
          if (rel?.kind === 'alliance') status = '🤝 союз';
          if (rel?.breakAt != null) status = `⚠️ ${status}, война с раунда ${rel.breakAt}`;
          return (
            <div key={p.id} className="dip-row">
              <div className="row">
                <span className="dot" style={{ background: p.color }} />
                <span className="grow">
                  {p.name}
                  {!p.alive && <span className="muted"> · пала</span>}
                </span>
                <span className="muted small">{p.alive ? status : ''}</span>
              </div>
              {p.alive && (
                <div className="chips dip-actions">
                  {outgoing && <span className="muted small">Ждём ответа…</span>}
                  {!outgoing && waiting && <span className="muted small">Ответьте на предложение выше</span>}
                  {!outgoing && !waiting && rel?.breakAt == null && (
                    <>
                      {!rel &&
                        TRUCE_ROUNDS.map((rounds) => (
                          <button
                            key={rounds}
                            type="button"
                            className="chip chip-pick"
                            onClick={() => void act({ type: 'propose', to: p.id, kind: 'truce', rounds })}
                          >
                            Перемирие {rounds} р.
                          </button>
                        ))}
                      {rel?.kind !== 'alliance' && (
                        <button
                          type="button"
                          className="chip chip-pick"
                          onClick={() => void act({ type: 'propose', to: p.id, kind: 'alliance' })}
                        >
                          Союз
                        </button>
                      )}
                      {rel && (
                        <button
                          type="button"
                          className="chip chip-pick warn"
                          onClick={() => void act({ type: 'breakTreaty', with: p.id })}
                        >
                          Разорвать
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <p className="muted small">
          Перемирие и союз запрещают нападать и стрелять друг по другу. Союзники видят карту вместе. Разрыв вступает в силу с
          вашего следующего хода. Если все выжившие — союзники, партия заканчивается общей победой.
        </p>
        <button className="btn full" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}
