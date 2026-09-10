/**
 * A rate (win rate / pick rate) drawn as a gold arc on a dark track
 * (design-system: gold = the highlighted figure, never a green/red WR tint).
 *
 * Two shapes:
 *  - default — the figure sits in the centre of the ring, a small caption below.
 *    Used in each `ChampionBuildPanel`'s header.
 *  - `inline` — arc only, with the figure folded into a one-line caption
 *    ("53.0% win rate"). Used in the champion page's overall-stats header, beside
 *    the champion portrait.
 *
 * `NaN` / `Infinity` render as an empty arc and an em dash (Requirement 5.5).
 */

import { formatRateToPercent } from '../domain/format';

export interface RadialStatProps {
  /** "Win rate" (default) / "win rate" (inline — it trails the figure in a sentence). */
  label: string;
  value: number;
  /**
   * default: goes on the `<text>` showing the figure.
   * inline: goes on the wrapper (which holds both figure and label).
   */
  testId?: string;
  inline?: boolean;
}

export function RadialStat({ label, value, testId, inline = false }: RadialStatProps) {
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const text = formatRateToPercent(value);

  return (
    <div
      className={inline ? 'radial-stat radial-stat--inline' : 'champion-build-radial'}
      data-testid={inline ? testId : undefined}
    >
      <svg
        viewBox="0 0 56 56"
        className={inline ? 'radial-stat-svg' : 'champion-build-radial-svg'}
        role="img"
        aria-label={`${label}: ${text}`}
      >
        <circle cx="28" cy="28" r={radius} className="champion-build-radial-track" />
        <circle
          cx="28"
          cy="28"
          r={radius}
          className="champion-build-radial-arc"
          strokeDasharray={`${fraction * circumference} ${circumference}`}
          transform="rotate(-90 28 28)"
        />
        {inline ? null : (
          <text x="28" y="28" className="champion-build-radial-value" data-testid={testId}>
            {text}
          </text>
        )}
      </svg>
      <span className={inline ? 'radial-stat-caption' : 'champion-build-radial-label'}>
        {inline ? `${text} ${label}` : label}
      </span>
    </div>
  );
}
