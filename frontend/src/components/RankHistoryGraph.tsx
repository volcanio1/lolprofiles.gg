/**
 * profile-sidebar Requirement 10: the Ranked Solo/Duo rank-over-time graph.
 *
 * A small inline SVG polyline — no charting dependency, consistent with this
 * codebase's dependency-free component style. One point per recorded
 * Rank_Snapshot (oldest → newest), plotted by `rankOrdinal`. Fewer than two
 * snapshots renders an explicit "history will build up" message rather than a
 * broken graph (Requirement 10.4). The horizontal axis is labelled neutrally
 * ("recorded over time"), never "games played" (Requirement 10.5) — the system
 * only observes a rank when someone looks the player up, and keeps a point once
 * ~3 ranked games have passed since the last (`specs/database/` Requirement 2.2).
 *
 * User request (2026-09-01): hovering anywhere along the line — not just the
 * dot itself — shows the NEAREST snapshot's date, rank/LP (colored to that
 * rank's tier), and how many Ranked Solo/Duo games happened since the previous
 * snapshot.
 *
 * ---------------------------------------------------------------------------
 * WHY HOVER ZONES ARE FIXED VERTICAL BANDS, NOT A MOUSEMOVE TRACKER
 * ---------------------------------------------------------------------------
 *
 * "Nearest snapshot to the cursor's x-position" is a static partition of the
 * graph's width — the midpoint between each pair of neighboring points is a
 * fixed boundary that never needs to be recomputed on move. So each point
 * owns a fixed-width band (its neighbors' midpoints, or the graph's edge for
 * the first/last point) instead of a `mousemove` handler measuring distance
 * on every pixel of motion — same visual result, far less code, and it reuses
 * `Tooltip`'s existing hover-per-element model instead of hand-rolling a
 * second one.
 *
 * `Tooltip` anchors on a plain HTML `<span>`, which cannot nest directly
 * inside an `<svg>` tree — so the SVG only draws the line and the visible
 * dots; the bands are a separate absolutely-positioned HTML overlay on top of
 * it, percentage-positioned against the same viewBox (exact, because the SVG
 * uses `preserveAspectRatio="none"`).
 */

import type { RankSnapshot, RecentMatchSummary } from '../api/types';
import { gamesSincePreviousSnapshot, rankColor, rankLabel, rankOrdinal } from '../domain/rankHistory';
import { Tooltip } from './Tooltip';

export interface RankHistoryGraphProps {
  history: readonly RankSnapshot[];
  /** Used only to approximate the games-since-previous-snapshot tooltip line; optional, defaults to none. */
  recentMatches?: readonly RecentMatchSummary[];
}

const VIEW_W = 280;
const VIEW_H = 96;
const PAD = 8;

/** `1_700_000_000_000` -> `"Nov 14, 2023"`. `''` for an unparseable timestamp. */
function formatSnapshotDate(observedAt: number): string {
  const parsed = new Date(observedAt);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function gamesSinceLine(count: number | undefined): string {
  if (count === undefined) {
    return 'First recorded snapshot';
  }
  return `${count} ranked game${count === 1 ? '' : 's'} since previous snapshot`;
}

export function RankHistoryGraph({ history, recentMatches = [] }: RankHistoryGraphProps) {
  if (history.length < 2) {
    return (
      <p data-testid="rank-history-pending" className="empty-note">
        Rank history builds up as this player plays more ranked games.
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
      <div className="rank-graph-svg-wrap">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="rank-graph-svg"
          role="img"
          aria-label={`Ranked Solo/Duo over ${String(history.length)} recorded points, ending at ${last !== undefined ? rankLabel(last) : ''}`}
          preserveAspectRatio="none"
        >
          <polyline points={polyline} className="rank-graph-line" />
          {points.map((p, index) => (
            <circle key={index} cx={p.x} cy={p.y} r={index === points.length - 1 ? 3 : 2} className="rank-graph-dot" />
          ))}
        </svg>
        <div className="rank-graph-hit-layer">
          {points.map((p, index) => {
            const snapshot = history[index];
            if (snapshot === undefined) {
              return null;
            }
            const gamesSince = gamesSincePreviousSnapshot(
              recentMatches,
              history[index - 1]?.observedAt,
              snapshot.observedAt,
            );
            // The band's edges are the midpoints to this point's neighbors —
            // see the header for why this stands in for a mousemove tracker.
            const prevX = points[index - 1]?.x;
            const nextX = points[index + 1]?.x;
            const leftX = prevX === undefined ? 0 : (prevX + p.x) / 2;
            const rightX = nextX === undefined ? VIEW_W : (p.x + nextX) / 2;
            return (
              <div
                key={index}
                className="rank-graph-hit-band"
                style={{ left: `${String((leftX / VIEW_W) * 100)}%`, width: `${String(((rightX - leftX) / VIEW_W) * 100)}%` }}
              >
                <Tooltip
                  className="rank-graph-hit-anchor"
                  title={formatSnapshotDate(snapshot.observedAt)}
                  body={
                    <>
                      <span className="tooltip-para" style={{ color: rankColor(snapshot.tier) }}>
                        {rankLabel(snapshot)}
                      </span>
                      <span className="tooltip-para">{gamesSinceLine(gamesSince)}</span>
                    </>
                  }
                >
                  <span className="rank-graph-hit-target" data-testid={`rank-history-point-${index}`} />
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
      <figcaption className="rank-graph-caption">
        <span>recorded over time</span>
        <span className="rank-graph-current">{last !== undefined ? rankLabel(last) : ''}</span>
      </figcaption>
    </figure>
  );
}
