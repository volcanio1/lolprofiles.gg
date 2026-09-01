/**
 * The Performance Feedback section (player-insights Requirements 7-13).
 *
 * Renders whatever `computePerformanceFeedback` produced, in the backend's own
 * order — no filtering here, since "only show what the player is lacking" is
 * already enforced backend-side (empty categories were never computed at
 * all). Two distinct empty states: no Ranked_Matches at all (Requirement
 * 13.4) vs. a ranked window with nothing triggered (Requirement 13.3) — the
 * caller distinguishes them via `hasRankedMatches` since the frontend has no
 * other way to tell "nothing to report" from "no ranked data to report on".
 */

import type { PerformanceFeedback } from '../api/types';

export interface PerformanceFeedbackPanelProps {
  performanceFeedback: readonly PerformanceFeedback[];
  /** Requirement 13.4: whether the analyzed player has any ranked games in this window at all. */
  hasRankedMatches: boolean;
}

const FEEDBACK_LABELS: Readonly<Record<PerformanceFeedback['category'], string>> = {
  csPerMinute: 'CS per minute',
  damageShare: 'Damage vs. team',
  killParticipation: 'Kill participation',
  jungleObjectives: 'Jungle objectives',
  lanePhaseDeaths: 'Lane phase deaths',
  earlyGameDeficit: 'Early game gold/CS',
};

export function PerformanceFeedbackPanel({ performanceFeedback, hasRankedMatches }: PerformanceFeedbackPanelProps) {
  if (!hasRankedMatches) {
    return (
      <p data-testid="no-ranked-games-for-feedback" className="empty-note">
        Performance feedback needs ranked games — play a few ranked matches to see it here.
      </p>
    );
  }

  if (performanceFeedback.length === 0) {
    return (
      <p data-testid="no-performance-feedback" className="empty-note">
        Nothing stood out in your recent ranked games.
      </p>
    );
  }

  return (
    <ul className="reco-list" role="list">
      {performanceFeedback.map((item) => (
        <li key={item.category} data-testid={`performance-feedback-${item.category}`} className="reco-item">
          <strong className="reco-label">{FEEDBACK_LABELS[item.category]}</strong>
          <span className="reco-text">{item.text}</span>
          <span data-testid={`metric-${item.category}`} className="reco-metric">
            {item.metricName}: {item.metricValue} (benchmark: {item.benchmarkValue})
          </span>
        </li>
      ))}
    </ul>
  );
}
