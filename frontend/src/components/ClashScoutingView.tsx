/**
 * The assembled Clash Scouting report (clash-scouting task 8.2/8.3).
 *
 * A team header (name, tier, tournament when known), the Scouting Insight
 * panel (ban recommendations in the backend's declared order, position
 * mismatches, stack cohesion), and the roster as a grid of `RosterMemberCard`s.
 * `tournament === null` renders the report without tournament details rather
 * than an empty placeholder (Requirement 4.4).
 */

import type { ClashScoutingReport } from '../api/types';
import { ChampionIcon } from './ChampionIcon';
import { RosterMemberCard } from './RosterMemberCard';
import { useStaticData } from '../staticData';

export interface ClashScoutingViewProps {
  report: ClashScoutingReport;
}

export function ClashScoutingView({ report }: ClashScoutingViewProps) {
  const mismatchedPuuids = new Set(report.insights.positionMismatches.map((entry) => entry.puuid));

  return (
    <section className="clash-scouting" aria-label="Clash scouting report" data-testid="clash-scouting">
      <header className="clash-header">
        <span className="clash-team-name">{report.team.name}</span>
        <span className="clash-team-abbr">{report.team.abbreviation}</span>
        <span className="clash-team-tier">Tier {report.team.tier}</span>
        {report.tournament !== null ? (
          <span className="clash-tournament" data-testid="clash-tournament">
            {report.tournament.nameKey}
          </span>
        ) : null}
      </header>

      <div className="clash-insights" aria-label="Scouting insights" data-testid="clash-insights">
        <div className="clash-insight-block">
          <h3 className="clash-insight-title">Ban recommendations</h3>
          {report.insights.banRecommendations.length === 0 ? (
            <p className="empty-note">Not enough data to recommend bans.</p>
          ) : (
            <ol className="clash-ban-list" data-testid="ban-recommendations">
              {report.insights.banRecommendations.map((ban) => (
                <BanRecommendationRow key={ban.championId} championId={ban.championId} recentWins={ban.recentWins} recentGames={ban.recentGames} />
              ))}
            </ol>
          )}
        </div>

        <div className="clash-insight-block">
          <h3 className="clash-insight-title">Stack cohesion</h3>
          <p className="clash-cohesion" data-testid="stack-cohesion">
            {report.insights.stackCohesion} of {report.roster.length} members queue together
          </p>
        </div>
      </div>

      <div className="roster-grid" data-testid="roster-grid">
        {report.roster.map((card) => (
          <RosterMemberCard key={card.puuid} card={card} isMismatched={mismatchedPuuids.has(card.puuid)} />
        ))}
      </div>
    </section>
  );
}

function BanRecommendationRow({
  championId,
  recentWins,
  recentGames,
}: {
  championId: number;
  recentWins: number;
  recentGames: number;
}) {
  const provider = useStaticData();
  const key = provider.championKeyForId(championId) ?? String(championId);
  return (
    <li className="clash-ban-row" data-testid="ban-recommendation">
      <ChampionIcon championKey={key} size={28} className="clash-ban-icon" />
      <span className="clash-ban-record">
        {recentWins}W-{recentGames - recentWins}L recent
      </span>
    </li>
  );
}
