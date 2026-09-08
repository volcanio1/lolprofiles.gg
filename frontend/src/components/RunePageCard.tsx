/**
 * One champion's complete rune page: keystone + primary tree, secondary tree,
 * and the three stat shards, in Riot's reported slot order.
 *
 * Lifted out of `RunesTab.tsx` by champion-build-stats task 12.1 so the champion
 * build page can reuse it. The prop is the rune page itself plus the champion
 * key, NOT a whole `MatchParticipant` — the match Runes tab passes
 * `participant.runes` / `participant.championName`, and `ChampionBuildPanel`
 * passes `build.runes` (which may be `null` below the modal threshold).
 *
 * The "unavailable" branch (a `null` page, or one Riot never reported) is this
 * component's own — callers do not need a separate empty state
 * (match-detail-tabs Requirement 4.4 / champion-build-stats Requirement 7.3).
 */

import type { RunePage } from '../api/types';
import { isRunePageUnavailable } from '../domain/participantOrder';
import { ChampionIcon } from './ChampionIcon';
import { RuneIcon } from './RuneIcon';
import { RuneTreeIcon } from './RuneTreeIcon';
import { StatShardIcon } from './StatShardIcon';

export interface RunePageCardProps {
  runes: RunePage | null;
  championKey: string;
  /** `analyzed` adds the "You" badge and the highlight class (the match tab's self row). */
  variant?: 'analyzed' | 'default';
  /** Stem for the card's `data-testid` (and `-unavailable`); omitted = no testids. */
  testId?: string;
  /** Copy for the unavailable branch; defaults to the match tab's wording. */
  unavailableText?: string;
}

export function RunePageCard({
  runes,
  championKey,
  variant = 'default',
  testId,
  unavailableText = 'Rune page unavailable.',
}: RunePageCardProps) {
  return (
    <li
      data-testid={testId}
      className={variant === 'analyzed' ? 'rune-page-card rune-page-card--analyzed' : 'rune-page-card'}
    >
      <div className="rune-page-identity">
        <ChampionIcon championKey={championKey} size={32} />
        {variant === 'analyzed' ? <span className="you-badge">You</span> : null}
      </div>

      {runes === null || isRunePageUnavailable(runes) ? (
        <p data-testid={testId === undefined ? undefined : `${testId}-unavailable`} className="rune-page-unavailable">
          {unavailableText}
        </p>
      ) : (
        <>
          {/* Requirement 4.4: three visually distinguishable groups. */}
          <div className="rune-group rune-group--primary">
            <RuneTreeIcon styleId={runes.primaryStyle} size={20} className="rune-group-tree-icon" />
            {runes.primarySelections.map((runeId, index) => (
              // Requirement 4.5: Riot's reported slot order, never sorted or deduped.
              <RuneIcon key={index} runeId={runeId} size={16} />
            ))}
          </div>
          <div className="rune-group rune-group--secondary">
            <RuneTreeIcon styleId={runes.secondaryStyle} size={20} className="rune-group-tree-icon" />
            {runes.secondarySelections.map((runeId, index) => (
              <RuneIcon key={index} runeId={runeId} size={16} />
            ))}
          </div>
          <div className="rune-group rune-group--shards">
            {runes.statShards.map((shardId, index) => (
              <StatShardIcon key={index} shardId={shardId} size={16} />
            ))}
          </div>
        </>
      )}
    </li>
  );
}
