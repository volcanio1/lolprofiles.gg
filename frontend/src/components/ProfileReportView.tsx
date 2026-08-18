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
 */

import type { ProfileReport, RankedQueueStanding } from '../api/types';

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
    <div data-testid="profile-report">
      <header>
        <h2 data-testid="report-riot-id">
          {report.riotId.gameName}#{report.riotId.tagLine}
        </h2>
        <p data-testid="summoner-level">Level {report.summonerLevel}</p>

        {/* Requirement 11.3 */}
        {report.partialDataWarning ? (
          <p role="status" data-testid="partial-data-warning">
            Some of this data may be outdated or unavailable — it was served from the last successful
            retrieval because a fresh update did not complete.
          </p>
        ) : null}

        {/* Requirements 11.4 / 11.5 */}
        {report.lastUpdated === null ? (
          <p data-testid="first-retrieval-notice">This data is being retrieved for the first time.</p>
        ) : (
          <p data-testid="last-updated">
            Last updated <time dateTime={report.lastUpdated}>{formatTimestamp(report.lastUpdated)}</time>
          </p>
        )}

        {/* Requirements 3.4 / 7.5 */}
        {report.limitedDataNotice ? (
          <p data-testid="limited-data-notice">
            Stats and insights are based on limited data, and additional fun facts require more match
            history.
          </p>
        ) : null}
      </header>

      {/* Requirements 6.1, 6.2, 6.6 */}
      <section aria-labelledby="ranked-heading">
        <h3 id="ranked-heading">Ranked standing</h3>
        {queueTypes.length === 0 ? (
          <p data-testid="no-ranked-entries">Unranked in every queue.</p>
        ) : (
          <ul>
            {queueTypes.map((queueType) => {
              const standing = report.stats.rankedByQueue[queueType];
              return (
                <li key={queueType} data-testid={`queue-${queueType}`}>
                  <span>{queueLabel(queueType)}: </span>
                  {standing === 'Unranked' ? (
                    <span>Unranked</span>
                  ) : (
                    <span>
                      {standing.tier} {standing.division} — {formatWinRate(standing.winRatePercent)} win rate
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Requirements 6.3, 6.5, 7.3 */}
      <section aria-labelledby="overview-heading">
        <h3 id="overview-heading">Recent form</h3>
        <ul>
          <li data-testid="overall-kda">Average KDA: {formatKda(report.stats.overallAverageKda)}</li>
          <li data-testid="most-played-role">Most-played role: {report.stats.mostPlayedRole}</li>
          <li data-testid="average-duration">
            Average match duration: {formatKda(report.averageMatchDurationMinutes)} minutes
          </li>
        </ul>
      </section>

      {/* Requirement 6.4 */}
      <section aria-labelledby="champions-heading">
        <h3 id="champions-heading">Top champions</h3>
        {report.stats.topChampions.length === 0 ? (
          <p data-testid="no-champions">No matches available to rank champions.</p>
        ) : (
          <table>
            <caption>Most-played champions in the recent match window</caption>
            <thead>
              <tr>
                <th scope="col">Champion</th>
                <th scope="col">Games</th>
                <th scope="col">Win rate</th>
                <th scope="col">KDA</th>
              </tr>
            </thead>
            <tbody>
              {report.stats.topChampions.map((champion) => (
                <tr key={champion.championName} data-testid={`champion-${champion.championName}`}>
                  <th scope="row">{champion.championName}</th>
                  <td>{champion.gamesPlayed}</td>
                  <td>{champion.winRatePercent}%</td>
                  <td>{formatKda(champion.averageKda)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Requirements 7.1, 7.2, 7.4 */}
      <section aria-labelledby="fun-facts-heading">
        <h3 id="fun-facts-heading">Fun facts</h3>
        {report.funFacts.length === 0 ? (
          <p data-testid="no-fun-facts">Not enough match history to derive fun facts yet.</p>
        ) : (
          <ul>
            {report.funFacts.map((fact) => (
              <li key={fact.category} data-testid={`fun-fact-${fact.category}`}>
                <strong>{FUN_FACT_LABELS[fact.category] ?? fact.category}: </strong>
                {fact.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Requirement 8.5 */}
      <section aria-labelledby="recommendations-heading">
        <h3 id="recommendations-heading">Improvement recommendations</h3>
        {report.recommendations.length === 0 ? (
          // Decision 3: zero is valid under the amended Requirement 8.1.
          <p data-testid="no-recommendations">
            No improvement recommendations were triggered by this match history.
          </p>
        ) : (
          <ul>
            {report.recommendations.map((recommendation) => (
              <li key={recommendation.category} data-testid={`recommendation-${recommendation.category}`}>
                <strong>{RECOMMENDATION_LABELS[recommendation.category] ?? recommendation.category}: </strong>
                {recommendation.text}
                {/* Requirement 8.5: the metric name and the value that triggered it. */}
                <span data-testid={`metric-${recommendation.category}`}>
                  {' '}
                  ({recommendation.metricName}: {recommendation.metricValue})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
