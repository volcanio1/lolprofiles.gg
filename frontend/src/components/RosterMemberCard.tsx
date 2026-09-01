/**
 * One roster member's card in a Clash Scouting report (clash-scouting task 8.2).
 *
 *  - Absent enrichment fields (`riotId`/`rankedEntries`/`championPool`) render
 *    blank rather than as zeros or placeholders — a failed call is silence, not
 *    a fabricated stat.
 *  - An empty `rankedEntries` array (a successful, unranked result) renders
 *    "Unranked", distinct from `null` (nothing shown for that field).
 *  - A position mismatch is flagged only when the backend's `positionMismatches`
 *    list names this member (Requirements 3.5/3.6 are already applied there).
 */

import type { ClashRosterCard } from '../api/types';
import { declaredPositionLabel, observedRoleLabel } from '../domain/clashScouting';
import { formatMasteryPoints } from '../domain/liveGame';
import { useStaticData } from '../staticData';
import { ChampionIcon } from './ChampionIcon';
import { RankIcon } from './RankIcon';

export interface RosterMemberCardProps {
  card: ClashRosterCard;
  isMismatched: boolean;
}

export function RosterMemberCard({ card, isMismatched }: RosterMemberCardProps) {
  const name = card.riotId !== null ? `${card.riotId.gameName}#${card.riotId.tagLine}` : 'Unknown player';
  const primaryStanding = (card.rankedEntries ?? []).find((entry) => entry !== 'Unranked');

  return (
    <div className="roster-card" data-testid="roster-card" data-puuid={card.puuid}>
      <div className="roster-card-identity">
        <span className="roster-card-name">
          {name}
          {card.isCaptain ? (
            <span className="roster-card-captain" data-testid="captain-badge">
              C
            </span>
          ) : null}
        </span>
        <span className="roster-card-position">{declaredPositionLabel(card.declaredPosition)}</span>
        {isMismatched ? (
          <span className="roster-card-mismatch" data-testid="position-mismatch-flag">
            Off-position — plays {card.observedRole !== null ? observedRoleLabel(card.observedRole) : ''}
          </span>
        ) : null}
      </div>

      <div className="roster-card-rank">
        {card.rankedEntries === null ? null : primaryStanding === undefined ? (
          <span className="roster-card-rank-none">Unranked</span>
        ) : (
          <>
            <RankIcon tier={primaryStanding.tier} size={24} className="roster-card-crest" />
            <span className="roster-card-rank-detail">
              {primaryStanding.tier} {primaryStanding.division} · {primaryStanding.leaguePoints} LP
            </span>
          </>
        )}
      </div>

      {card.championPool !== null && card.championPool.length > 0 ? (
        <div className="roster-card-pool" aria-label="Champion pool">
          {card.championPool.map((entry) => (
            <ChampionPoolChip key={entry.championId} championId={entry.championId} masteryPoints={entry.masteryPoints} />
          ))}
        </div>
      ) : null}

      {card.recentForm.length > 0 ? (
        <div className="roster-card-form" aria-label="Recent form" data-testid="recent-form">
          {card.recentForm.map((entry) => (
            <span
              key={entry.matchId}
              className={entry.win ? 'roster-card-form-pip roster-card-form-pip--win' : 'roster-card-form-pip'}
              title={entry.win ? 'Win' : 'Loss'}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChampionPoolChip({ championId, masteryPoints }: { championId: number; masteryPoints: number }) {
  const provider = useStaticData();
  const key = provider.championKeyForId(championId) ?? String(championId);
  return (
    <span className="roster-card-pool-chip" data-testid="champion-pool-entry">
      <ChampionIcon championKey={key} size={20} className="roster-card-pool-icon" />
      <span className="roster-card-pool-points">{formatMasteryPoints(masteryPoints)}</span>
    </span>
  );
}
