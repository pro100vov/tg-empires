import type { Coord, LogEntry } from '@tge/shared';

interface Props {
  log: LogEntry[];
  onPick: (at: Coord) => void;
  onClose: () => void;
}

/** Последние записи журнала; тап по записи с клеткой показывает её на карте. */
export default function LogSheet({ log, onPick, onClose }: Props) {
  const recent = log.slice(-30).reverse();
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card sheet" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">Журнал</div>
        <div className="log-list">
          {recent.length === 0 && <p className="muted small">Пока ничего не происходило.</p>}
          {recent.map((entry, i) => {
            const at = entry.at;
            return (
              <button
                key={`${log.length - i}`}
                type="button"
                className={`log-item${at ? ' log-item-at' : ''}`}
                disabled={!at}
                onClick={() => {
                  if (!at) return;
                  onPick(at);
                  onClose();
                }}
              >
                <b>{entry.round}</b> {entry.text}
                {at ? <span className="log-pin"> 📍</span> : null}
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
