import { canAfford, eraOf, eventById, eventName, eventText } from '@tge/shared';
import type { GameState, Player } from '@tge/shared';

interface CardProps {
  state: GameState;
  me: Player;
  onChoice: (choice: 0 | 1) => void;
  onClose: () => void;
}

/** Карточка случайного события в начале хода: что случилось и, если нужно, выбор из двух. */
export default function EventCard({ state, me, onChoice, onClose }: CardProps) {
  const event = me.event;
  const def = event ? eventById(event.id) : undefined;
  if (!event || !def) return null;
  const era = eraOf(state.settings);
  const choice = def.choice;
  const affordable = !choice?.cost || canAfford(me.resources, choice.cost);
  return (
    <div className="overlay center" onClick={event.pending ? undefined : onClose}>
      <div className={`overlay-card event-card event-${def.tone}`} onClick={(e) => e.stopPropagation()}>
        <div className="hero-icon">{def.icon}</div>
        <h2>{eventName(def, era)}</h2>
        <p>{eventText(def, era)}</p>
        {event.pending && choice ? (
          <>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn primary grow" disabled={!affordable} onClick={() => onChoice(1)}>
                {choice.accept}
              </button>
            </div>
            {!affordable && <p className="muted small">Не хватает ресурсов.</p>}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn grow" onClick={() => onChoice(0)}>
                {choice.decline}
              </button>
            </div>
            <button className="btn tiny event-later" onClick={onClose}>
              Решить позже (до конца хода)
            </button>
          </>
        ) : (
          <>
            {event.detail && <p className="event-detail">{event.detail}</p>}
            <button className="btn primary" style={{ marginTop: 12 }} onClick={onClose}>
              Понятно
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Значки действующих эффектов под панелью ресурсов. */
export function EffectChips({ me }: { me: Player }) {
  if (me.effects.length === 0) return null;
  return (
    <div className="effect-chips">
      {me.effects.map((effect) => {
        const def = eventById(effect.id);
        const left =
          effect.researchDiscount != null
            ? 'до первой технологии'
            : `ещё ${effect.turnsLeft} ${effect.turnsLeft === 1 ? 'ход' : effect.turnsLeft < 5 ? 'хода' : 'ходов'}`;
        return (
          <span key={effect.id} className={`effect-chip ${def?.tone ?? ''}`} title={`${def?.name ?? effect.id} — ${left}`}>
            {def?.icon ?? '✨'} {left}
          </span>
        );
      })}
    </div>
  );
}
