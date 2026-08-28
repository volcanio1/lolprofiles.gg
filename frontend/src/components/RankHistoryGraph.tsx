/**
 * profile-sidebar Requirement 10: the Ranked Solo/Duo rank-over-time graph.
 *
 * A small inline SVG polyline — no charting dependency, consistent with this
 * codebase's dependency-free component style. One point per recorded
 * Rank_Snapshot (oldest → newest), plotted by `rankOrdinal`. Fewer than two
 * snapshots renders an explicit "history will build up" message rather than a
 * broken graph (Requirement 10.4). The horizontal axis is "lookups over time",
 * never "games played" (Requirement 10.5) — the system only observes a rank when
 * someone looks the player up.
 */

import { useId } from 'react';

import type { RankSnapshot } from '../api/types';
import { rankLabel, rankOrdinal } from '../domain/rankHistory';

export interface RankHistoryGraphProps {
  history: readonly RankSnapshot[];
}

const VIEW_W = 280;
const VIEW_H = 96;
const PAD = 8;

export function RankHistoryGraph({ history }: RankHistoryGraphProps) {
  const titleId = useId();

  if (history.length < 2) {
    return (
      <p data-testid="rank-history-pending" className="empty-note">
        Rank history will build up over future lookups.
      </p>
    );
  }

  const ordinals = history.map(rankOrdinal);
  const min = Math.min(...ordinals);
  const max = Math.max(...ordinals);
  const span = max - min || 1;

  const points = ordinals.map((value, index) => {
    const x = PAD + (index / (history.length - 1)) * (VIEW_W - 2 * PAD);
    const y = VIEW_H - PAD - ((value - min) / span) * (VIEW_H - 2 * PAD);
    return { x, y };
  });

  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = history[history.length - 1];

  return (
    <figure className="rank-graph" data-testid="rank-history-graph">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="rank-graph-svg"
        role="img"
        aria-labelledby={titleId}
        preserveAspectRatio="none"
      >
        <title id={titleId}>
          Ranked Solo/Duo over {history.length} lookups, ending at {rankLabel(last)}
        </title>
        <polyline points={polyline} className="rank-graph-line" />
        {points.map((p, index) => (
          <circle key={index} cx={p.x} cy={p.y} r={index === points.length - 1 ? 3 : 2} className="rank-graph-dot" />
        ))}
      </svg>
      <figcaption className="rank-graph-caption">
        <span>lookups over time</span>
        <span className="rank-graph-current">{rankLabel(last)}</span>
      </figcaption>
    </figure>
  );
}
