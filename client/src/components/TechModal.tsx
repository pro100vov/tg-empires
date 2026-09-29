import { canAfford, techCostFor, techsFor } from '@tge/shared';
import type { EraId, Player, TechType } from '@tge/shared';

interface Props {
  player: Player;
  isMyTurn: boolean;
  actionsLeft: number;
  era: EraId;
  onResearch: (tech: TechType) => void;
  onClose: () => void;
}

export default function TechModal({ player, isMyTurn, actionsLeft, era, onResearch, onClose }: Props) {
  const catalog = techsFor(era);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card sheet" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">Технологии державы</div>
        {(Object.keys(catalog) as TechType[]).map((key) => {
          const info = catalog[key];
          const level = player.tech[key];
          const maxed = level >= info.maxLevel;
          const cost = techCostFor(player, level);
          const affordable = canAfford(player.resources, cost);
          return (
            <div key={key} className="tech-row">
              <span className="tech-icon">{info.icon}</span>
              <div className="grow">
                <div className="tech-name">
                  {info.name} <span className="muted">ур. {level}/{info.maxLevel}</span>
                </div>
                <div className="muted small">{info.description}</div>
              </div>
              <button
                className="btn small"
                disabled={maxed || !affordable || !isMyTurn || actionsLeft < 1}
                onClick={() => onResearch(key)}
              >
                {maxed ? 'макс.' : `🪙${cost.gold} 🌾${cost.food} 🔩${cost.iron}`}
              </button>
            </div>
          );
        })}
        <button className="btn full" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}
