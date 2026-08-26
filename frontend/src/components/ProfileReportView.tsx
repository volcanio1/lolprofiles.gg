/**
 * Profile report rendering.
 *
 * Implements:
 *  - 6.1: tier and division per queue type, or "Unranked" for a queue with no entry.
 *  - 6.2/6.6: win rate as a whole percent, or "N/A" when wins + losses is 0.
 *  - 6.3: overall average KDA to 2 decimal places.
 *  - 6.4: up to 5 top champions with name, games, win rate and KDA, in backend order.
 *  - 6.5: the most-played role.
 *  - 7.1/7.2/7.4/7.5: the fun facts, and the limited-data notice.
 *  - 7.3: the average match duration in minutes.
 *  - 8.5: each recommendation with its metric name and computed value.
 *  - 11.3: the staleness indication when the report came from cache after a failure.
 *  - 11.4/11.5: the last-updated timestamp, or a first-retrieval indication.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. NUMBERS ARE FORMATTED, NEVER RECOMPUTED. Every value here is already rounded
 *    by the Insight Engine to the precision its requirement specifies — win rate to a
 *    whole percent, KDA and duration to 2 decimals. Re-deriving anything in the view
 *    would create a second source of truth that could disagree with the values the
 *    property tests verified. `formatKda` only pads the display to 2 decimal places;
 *    it does not change the number.
 *
 * 2. QUEUE ORDER IS FIXED, NOT OBJECT ORDER. `rankedByQueue` is a record, and
 *    relying on its key order would make the display depend on Riot's response
 *    order. Known queues render in a stable, meaningful order (solo, flex, then
 *    anything else alphabetically) so the same profile always looks the same. The
 *    "anything else" branch matters in practice: a live lookup returned
 *    `RANKED_PREMADE_5x5`, which no hardcoded list would have anticipated.
 *
 * 3. AN EMPTY SECTION SAYS SO RATHER THAN VANISHING. Zero recommendations is a
 *    valid outcome under the amended Requirement 8.1, and an empty match window
 *    yields no champions and no fun facts. Rendering an explicit "nothing here"
 *    line distinguishes "we analyzed and found nothing to say" from "this part of
 *    the page failed to load".
 *
 * 4. THE TIMESTAMP IS RENDERED IN THE VISITOR'S LOCALE, with the raw ISO value in
 *    `dateTime` on a `<time>` element. Requirement 11.4 asks for the timestamp to be
 *    displayed and does not fix a format, and unlike the Insight Engine — which had
 *    to avoid locale entirely to stay pure and testable — presentation is exactly
 *    where locale belongs.
 *
 * 5. THE CHAMPIONS TABLE IS THE ONLY TABLE IN A DEFAULT RENDER. Ranked standings
 *    and the recent-form stats are styled lists, not tables, so tests that address
 *    "the table" by role keep meaning the champions table; per-match matchup tables
 *    appear only when recent matches exist.
 */

import type { OpponentSummary, ProfileReport, RankedQueueStanding, RecentMatchSummary } from '../api/types';
import { ChampionIcon } from './ChampionIcon';
import { ItemBuildRow } from './ItemBuildRow';
import { ProfileIcon } from './ProfileIcon';

export interface ProfileReportViewProps {
  report: ProfileReport;
}

/** Decision 2: stable display order regardless of Riot's response order. */
const QUEUE_ORDER: readonly string[] = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'];

const QUEUE_LABELS: Readonly<Record<string, string>> = {
  RANKED_SOLO_5x5: 'Ranked Solo/Duo',
  RANKED_FLEX_SR: 'Ranked Flex',
  RANKED_FLEX_TT: 'Ranked Flex (Twisted Treeline)',
  RANKED_PREMADE_5x5: 'Ranked Premade',
  RANKED_TFT: 'Teamfight Tactics',
};

export function queueLabel(queueType: string): string {
  return QUEUE_LABELS[queueType] ?? queueType;
}

/** Decision 2. */
export function orderedQueueTypes(rankedByQueue: Record<string, RankedQueueStanding>): string[] {
  const present = Object.keys(rankedByQueue);
  const known = QUEUE_ORDER.filter((queueType) => present.includes(queueType));
  const rest = present.filter((queueType) => !QUEUE_ORDER.includes(queueType)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...known, ...rest];
}

/** Decision 1: pads for display only. */
export function formatKda(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

/** Requirements 6.2/6.6. */
export function formatWinRate(winRatePercent: number | 'N/A'): string {
  return winRatePercent === 'N/A' ? 'N/A' : `${String(winRatePercent)}%`;
}

/** Decision 4. */
function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

/** Renders an epoch-ms match timestamp the same way as `formatTimestamp`. */
function formatMatchDate(epochMs: number): string {
  const parsed = new Date(epochMs);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString();
}

function formatKda3(kills: number, deaths: number, assists: number): string {
  return `${String(kills)}/${String(deaths)}/${String(assists)}`;
}

/** CS/min with the raw CS count in brackets, e.g. `5.6(124)`. */
export function formatCsPerMinute(csPerMinute: number, cs: number): string {
  const rate = Number.isFinite(csPerMinute) ? csPerMinute.toFixed(1) : '0.0';
  const raw = Number.isInteger(cs) ? String(cs) : cs.toFixed(2);
  return `${rate}(${raw})`;
}

function LaneStatsRow({ label, championName, kills, deaths, assists, cs, csPerMinute, visionScore }: {
  label: string;
  championName: string;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  csPerMinute: number;
  visionScore: number;
}) {
  return (
    <tr>
      <th scope="row" className="side-label">
        {label}
      </th>
      <td className="champion-col">
        <ChampionIcon championKey={championName} size={24} className="lane-champion-icon" />
      </td>
      <td>{formatKda3(kills, deaths, assists)}</td>
      <td>{formatCsPerMinute(csPerMinute, cs)}</td>
      <td>{visionScore}</td>
    </tr>
  );
}

function RecentMatchCard({ match }: { match: RecentMatchSummary }) {
  const opponent: OpponentSummary | null = match.opponent;
  return (
    <li
      data-testid={`recent-match-${match.matchId}`}
      className={match.win ? 'match-card match-card--win' : 'match-card'}
    >
      <p className="match-head">
        <span className="match-outcome">{match.win ? 'Victory' : 'Defeat'}</span>
        <span className="match-champion">
          <ChampionIcon championKey={match.championName} size={32} className="match-champion-icon" />
        </span>
        <span className="match-role">{match.role}</span>
        <span className="match-date">{formatMatchDate(match.startTimestamp)}</span>
      </p>
      <div className="table-scroll">
        <table className="data-table matchup-table">
          <caption className="sr-only">
            {match.championName} vs {opponent === null ? 'unknown opponent' : opponent.championName}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Side</span>
              </th>
              <th scope="col" className="champion-col">Champion</th>
              <th scope="col">K/D/A</th>
              <th scope="col">CS/min</th>
              <th scope="col">Vision</th>
            </tr>
          </thead>
          <tbody>
            <LaneStatsRow
              label="You"
              championName={match.championName}
              kills={match.kills}
              deaths={match.deaths}
              assists={match.assists}
              cs={match.cs}
              csPerMinute={match.csPerMinute}
              visionScore={match.visionScore}
            />
            {opponent === null ? (
              <tr>
                <th scope="row" className="side-label">
                  Opponent
                </th>
                <td colSpan={4} data-testid={`recent-match-${match.matchId}-no-opponent`} className="matchup-note">
                  No lane opponent could be identified for this match.
                </td>
              </tr>
            ) : (
              <LaneStatsRow
                label="Opponent"
                championName={opponent.championName}
                kills={opponent.kills}
                deaths={opponent.deaths}
                assists={opponent.assists}
                cs={opponent.cs}
                csPerMinute={opponent.csPerMinute}
                visionScore={opponent.visionScore}
              />
            )}
          </tbody>
        </table>
      </div>
      {/* Requirements 3.3, 3.4, 3.7, 3.8: final inventory at game end, never a purchase order. */}
      <div className="build-compare" data-testid={`recent-match-${match.matchId}-builds`}>
        <div className="build-compare-side">
          <span className="build-compare-label">Your final build</span>
          <ItemBuildRow build={match.build} size={24} />
        </div>
        {opponent === null ? null : (
          <div className="build-compare-side">
            <span className="build-compare-label">Opponent's final build</span>
            <ItemBuildRow build={opponent.build} size={24} />
          </div>
        )}
      </div>
    </li>
  );
}

const FUN_FACT_LABELS: Readonly<Record<string, string>> = {
  rolePreference: 'Role preference',
  championLoyalty: 'Champion loyalty',
  timeOfDay: 'When they play',
  streak: 'Streaks',
};

const RECOMMENDATION_LABELS: Readonly<Record<string, string>> = {
  survivability: 'Survivability',
  championSelection: 'Champion selection',
  visionControl: 'Vision control',
};

export function ProfileReportView({ report }: ProfileReportViewProps) {
  const queueTypes = orderedQueueTypes(report.stats.rankedByQueue);

  return (
    <div data-testid="profile-report" className="report">
      <header className="report-identity">
        <div className="rid-row">
          <ProfileIcon profileIconId={report.profileIconId} size={48} className="rid-icon" />
          <h2 data-testid="report-riot-id" className="rid">
            <span>{report.riotId.gameName}</span>
            <span className="rid-tag">#{report.riotId.tagLine}</span>
          </h2>
        </div>

        <div className="report-meta">
          <p data-testid="summoner-level">Level {report.summonerLevel}</p>

          {/* Requirements 11.4 / 11.5 */}
          {report.lastUpdated === null ? (
            <p data-testid="first-retrieval-notice">This data is being retrieved for the first time.</p>
          ) : (
            <p data-testid="last-updated">
              Last updated <time dateTime={report.lastUpdated}>{formatTimestamp(report.lastUpdated)}</time>
            </p>
          )}
        </div>

        {/* Requirement 11.3 */}
        {report.partialDataWarning ? (
          <p role="status" data-testid="partial-data-warning" className="notice-warning">
            Some of this data may be outdated or unavailable — it was served from the last successful
            retrieval because a fresh update did not complete.
          </p>
        ) : null}

        {/* Requirements 3.4 / 7.5 */}
        {report.limitedDataNotice ? (
          <p data-testid="limited-data-notice" className="notice-muted">
            Stats and insights are based on limited data, and additional fun facts require more match
            history.
          </p>
        ) : null}
      </header>

      {/* Requirements 6.1, 6.2, 6.6 */}
      <section className="rsec" aria-labelledby="ranked-heading">
        <h3 id="ranked-heading" className="rsec-title">
          Ranked standing
        </h3>
        {queueTypes.length === 0 ? (
          <p data-testid="no-ranked-entries" className="empty-note">
            Unranked in every queue.
          </p>
        ) : (
          <ul className="queue-grid" role="list">
            {queueTypes.map((queueType) => {
              const standing = report.stats.rankedByQueue[queueType];
              return (
                <li key={queueType} data-testid={`queue-${queueType}`} className="queue-card">
                  <span className="queue-card-label">{queueLabel(queueType)}</span>
                  {standing === 'Unranked' ? (
                    <span className="queue-card-tier queue-card-tier--none">Unranked</span>
                  ) : (
                    <>
                      <span className="queue-card-tier">
                        {standing.tier} {standing.division}
                      </span>
                      <span className="queue-card-wr">{formatWinRate(standing.winRatePercent)} win rate</span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Requirements 6.3, 6.5, 7.3 */}
      <section className="rsec" aria-labelledby="overview-heading">
        <h3 id="overview-heading" className="rsec-title">
          Recent form
        </h3>
        <ul className="stat-tiles" role="list">
          <li data-testid="overall-kda" className="stat-tile">
            <span className="stat-tile-label">Average KDA</span>
            <strong className="stat-tile-value">{formatKda(report.stats.overallAverageKda)}</strong>
          </li>
          <li data-testid="most-played-role" className="stat-tile">
            <span className="stat-tile-label">Most-played role</span>
            <strong className="stat-tile-value">{report.stats.mostPlayedRole}</strong>
          </li>
          <li data-testid="average-duration" className="stat-tile">
            <span className="stat-tile-label">Average match duration</span>
            <strong className="stat-tile-value">
              {formatKda(report.averageMatchDurationMinutes)} <span className="stat-tile-unit">minutes</span>
            </strong>
          </li>
        </ul>
      </section>

      {/* Requirement 6.4 */}
      <section className="rsec" aria-labelledby="champions-heading">
        <h3 id="champions-heading" className="rsec-title">
          Top champions
        </h3>
        {report.stats.topChampions.length === 0 ? (
          <p data-testid="no-champions" className="empty-note">
            No matches available to rank champions.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">Most-played champions in the recent match window</caption>
              <thead>
                <tr>
                  <th scope="col">Champion</th>
                  <th scope="col">Games</th>
                  <th scope="col">Win rate</th>
                  <th scope="col">KDA</th>
                  <th scope="col">Avg CS/min</th>
                </tr>
              </thead>
              <tbody>
                {report.stats.topChampions.map((champion) => (
                  <tr key={champion.championName} data-testid={`champion-${champion.championName}`}>
                    <th scope="row">
                      <ChampionIcon championKey={champion.championName} size={32} className="top-champion-icon" />
                    </th>
                    <td>{champion.gamesPlayed}</td>
                    <td>{champion.winRatePercent}%</td>
                    <td>{formatKda(champion.averageKda)}</td>
                    <td data-testid={`champion-${champion.championName}-avg-cs`}>
                      {formatCsPerMinute(champion.averageCsPerMinute, champion.averageCs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rsec" aria-labelledby="recent-matches-heading">
        <h3 id="recent-matches-heading" className="rsec-title">
          Recent matches
        </h3>
        {report.recentMatches.length === 0 ? (
          <p data-testid="no-recent-matches" className="empty-note">
            No recent matches available.
          </p>
        ) : (
          <ul className="match-list" role="list">
            {report.recentMatches.map((match) => (
              <RecentMatchCard key={match.matchId} match={match} />
            ))}
          </ul>
        )}
      </section>

      <div className="rsec-duo">
        {/* Requirements 7.1, 7.2, 7.4 */}
        <section className="rsec" aria-labelledby="fun-facts-heading">
          <h3 id="fun-facts-heading" className="rsec-title">
            Fun facts
          </h3>
          {report.funFacts.length === 0 ? (
            <p data-testid="no-fun-facts" className="empty-note">
              Not enough match history to derive fun facts yet.
            </p>
          ) : (
            <ul className="fact-list" role="list">
              {report.funFacts.map((fact) => (
                <li key={fact.category} data-testid={`fun-fact-${fact.category}`} className="fact-item">
                  <strong className="fact-label">{FUN_FACT_LABELS[fact.category] ?? fact.category}</strong>
                  <span className="fact-text">{fact.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Requirement 8.5 */}
        <section className="rsec" aria-labelledby="recommendations-heading">
          <h3 id="recommendations-heading" className="rsec-title">
            Improvement recommendations
          </h3>
          {report.recommendations.length === 0 ? (
            // Decision 3: zero is valid under the amended Requirement 8.1.
            <p data-testid="no-recommendations" className="empty-note">
              No improvement recommendations were triggered by this match history.
            </p>
          ) : (
            <ul className="reco-list" role="list">
              {report.recommendations.map((recommendation) => (
                <li
                  key={recommendation.category}
                  data-testid={`recommendation-${recommendation.category}`}
                  className="reco-item"
                >
                  <strong className="reco-label">
                    {RECOMMENDATION_LABELS[recommendation.category] ?? recommendation.category}
                  </strong>
                  <span className="reco-text">{recommendation.text}</span>
                  {/* Requirement 8.5: the metric name and the value that triggered it. */}
                  <span data-testid={`metric-${recommendation.category}`} className="reco-metric">
                    {recommendation.metricName}: {recommendation.metricValue}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
