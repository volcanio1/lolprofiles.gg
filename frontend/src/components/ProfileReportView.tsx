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

import { useMemo, useState } from 'react';

import type { ProfileReport, QueueFilterValue, RankedQueueStanding } from '../api/types';
import { formatKda, formatWinRate } from '../domain/format';
import {
  SIDEBAR_QUEUE_FILTER_DEFAULT,
  availableQueueFilterValues,
  standingQueueFor,
} from '../domain/queueFilters';
import { platformLabel } from '../domain/regions';
import { ChampionPreferences } from './ChampionPreferences';
import { GamemodeFilter } from './GamemodeFilter';
import { PremadesPanel } from './PremadesPanel';
import { RankHistoryGraph } from './RankHistoryGraph';
import { RolePerformancePanel } from './RolePerformancePanel';
import { MatchRow } from './MatchRow';
import { ProfileIcon } from './ProfileIcon';
import { RankIcon } from './RankIcon';

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

// Formatting helpers live in `domain/format.ts` now (shared with the sidebar
// panels); re-exported here so existing importers/tests are unaffected.
export { formatKda, formatWinRate };

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

/**
 * Recent-matches queue filter. `queueTypes` lists the raw `match.queueType`
 * values (as classified in `orchestrator/mapping.ts`) an option matches; `all`
 * matches everything. "Ranked 5v5" covers the legacy premade-team queue values,
 * which the backend does not currently classify but may in future.
 */
export const RECENT_MATCH_QUEUE_FILTERS: readonly {
  value: string;
  label: string;
  queueTypes: readonly string[];
}[] = [
  { value: 'all', label: 'All queues', queueTypes: [] },
  { value: 'ranked-solo', label: 'Ranked Solo/Duo', queueTypes: ['ranked solo/duo'] },
  { value: 'ranked-flex', label: 'Ranked Flex', queueTypes: ['ranked flex'] },
  { value: 'ranked-5s', label: 'Ranked 5v5', queueTypes: ['ranked 5s', 'ranked premade'] },
  { value: 'normal', label: 'Normal', queueTypes: ['normal'] },
  { value: 'aram', label: 'ARAM', queueTypes: ['aram'] },
  { value: 'aram-mayhem', label: 'ARAM Mayhem', queueTypes: ['aram mayhem'] },
];

/** How many recent matches are shown at once, and how many each "Load more" reveals. */
export const RECENT_MATCHES_PAGE_SIZE = 10;

export function ProfileReportView({ report }: ProfileReportViewProps) {
  // profile-sidebar Requirement 9.4: the sidebar filter defaults to ranked
  // solo/duo and governs Champion_Preferences + Role_Performance. It is
  // independent of the recent-matches queue filter below (Requirement 9.2).
  const [sidebarQueueFilter, setSidebarQueueFilter] = useState<QueueFilterValue>(SIDEBAR_QUEUE_FILTER_DEFAULT);
  const availableFilterValues = useMemo(() => availableQueueFilterValues(report), [report]);
  const sidebarSlice = report.statsByQueue[sidebarQueueFilter];
  const sidebarRoles = report.rolePerformanceByQueue[sidebarQueueFilter];
  const sidebarPremades = report.premadesByQueue[sidebarQueueFilter];
  const standingQueue = standingQueueFor(sidebarQueueFilter, report.stats.rankedByQueue);

  const [queueFilter, setQueueFilter] = useState('all');
  const [visibleCount, setVisibleCount] = useState(RECENT_MATCHES_PAGE_SIZE);
  const filteredMatches = useMemo(() => {
    const option = RECENT_MATCH_QUEUE_FILTERS.find((entry) => entry.value === queueFilter);
    if (!option || option.queueTypes.length === 0) {
      return report.recentMatches;
    }
    return report.recentMatches.filter((match) => option.queueTypes.includes(match.queueType));
  }, [queueFilter, report.recentMatches]);
  const visibleMatches = filteredMatches.slice(0, visibleCount);

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
          {/* lookup-pipeline-fixes Requirement 4.2/4.3: a neutral placeholder when
              the Summoner-V4 enrichment call failed, never a zero or a blank. */}
          <p data-testid="summoner-level">
            Level {report.summonerLevel === null ? <span data-testid="summoner-level-unavailable">—</span> : report.summonerLevel}
          </p>

          {/* Requirement 2.3: which platform the data came from. */}
          <p data-testid="resolved-platform">
            Server: {platformLabel(report.resolvedPlatform)}
            {report.usedPlatformOverride ? (
              <span data-testid="platform-override-notice" className="notice-muted-inline">
                {' '}
                (manual override)
              </span>
            ) : null}
          </p>

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

      {/* profile-sidebar Requirement 1: the report splits into a summary rail
          (identity above, then "who is this / how good") and a wider main column
          for the match-by-match detail a visitor scrolls. Task 1 introduces the
          wrappers only; the two-column grid and sticky behaviour are task 2. */}
      <div className="report-columns">
        <aside className="report-sidebar" aria-label="Player summary">
          {/* profile-sidebar Requirement 10.3: rank-over-time graph, top of the rail. */}
          <section className="rsec" aria-labelledby="rank-history-heading">
            <h3 id="rank-history-heading" className="rsec-title">
              Ranked Solo/Duo history
            </h3>
            <RankHistoryGraph history={report.rankHistory} />
          </section>

          {/* profile-sidebar Requirement 9.1/9.4: governs the two panels below. */}
          <GamemodeFilter
            value={sidebarQueueFilter}
            onChange={setSidebarQueueFilter}
            availableValues={availableFilterValues}
            label="Filter champion stats and role performance by queue"
            testId="sidebar-queue-filter"
          />

          {/* Requirements 6.1, 6.2, 6.6 — a single standing, for the queue the
              gamemode filter selects (the user wants one, not the whole list). */}
          <section className="rsec rsec--tight" aria-labelledby="ranked-heading">
            <h3 id="ranked-heading" className="rsec-title">
              Ranked standing
            </h3>
            {standingQueue === undefined ? (
              <p data-testid="no-ranked-entries" className="empty-note">
                Unranked in every queue.
              </p>
            ) : (
              (() => {
                const standing = report.stats.rankedByQueue[standingQueue];
                return (
                  <div data-testid={`queue-${standingQueue}`} className="rank-standing rank-standing--solo">
                    <RankIcon
                      tier={standing === 'Unranked' ? '' : standing.tier}
                      size={40}
                      className="rank-standing-crest"
                    />
                    <span className="rank-standing-queue">{queueLabel(standingQueue)}</span>
                    {standing === 'Unranked' ? (
                      <span className="rank-standing-tier rank-standing-tier--none">Unranked</span>
                    ) : (
                      <span className="rank-standing-detail">
                        <span className="rank-standing-tier">
                          {standing.tier} {standing.division} · {standing.leaguePoints} LP
                        </span>
                        <span className="rank-standing-wr">{formatWinRate(standing.winRatePercent)} WR</span>
                      </span>
                    )}
                  </div>
                );
              })()
            )}

            {/* Requirements 6.3, 6.5, 7.3 — the match-window summary, scoped to
                the selected gamemode filter like the panels below. */}
            <dl className="rank-extra">
              <div className="rank-extra-stat" data-testid="overall-kda">
                <dt>Avg KDA</dt>
                <dd>{formatKda(sidebarSlice.overallAverageKda)}</dd>
              </div>
              <div className="rank-extra-stat" data-testid="most-played-role">
                <dt>Top role</dt>
                <dd>{sidebarSlice.mostPlayedRole}</dd>
              </div>
              <div className="rank-extra-stat" data-testid="average-duration">
                <dt>Avg length</dt>
                <dd>{Math.round(sidebarSlice.averageMatchDurationMinutes)}m</dd>
              </div>
            </dl>
          </section>

          {/* profile-sidebar Requirement 7: Champion_Preferences, scoped to the
              Sidebar_Queue_Filter, as a compact table (Requirement 7.5). */}
          <section className="rsec rsec--tight" aria-labelledby="champions-heading">
            <h3 id="champions-heading" className="rsec-title">
              Champion preferences
            </h3>
            <ChampionPreferences champions={sidebarSlice.topChampions} />
          </section>

          {/* profile-sidebar Requirement 8: Role_Performance, same queue scope. */}
          <section className="rsec rsec--tight" aria-labelledby="role-perf-heading">
            <h3 id="role-perf-heading" className="rsec-title">
              Role performance
            </h3>
            <RolePerformancePanel roles={sidebarRoles} />
          </section>

          {/* Premades — recurring teammates, same queue scope. */}
          <section className="rsec rsec--tight" aria-labelledby="premades-heading">
            <h3 id="premades-heading" className="rsec-title">
              Premades
            </h3>
            <PremadesPanel premades={sidebarPremades} />
          </section>
        </aside>

        <div className="report-main">
          <section className="rsec" aria-labelledby="recent-matches-heading">
            <div className="rsec-title-row">
              <h3 id="recent-matches-heading" className="rsec-title">
                Recent matches
              </h3>
              <label className="rsec-filter">
                <span className="sr-only">Filter recent matches by queue type</span>
                <select
                  className="field-select rsec-filter-select"
                  data-testid="recent-matches-queue-filter"
                  value={queueFilter}
                  onChange={(event) => {
                    setQueueFilter(event.target.value);
                    setVisibleCount(RECENT_MATCHES_PAGE_SIZE);
                  }}
                >
                  {RECENT_MATCH_QUEUE_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {report.recentMatches.length === 0 ? (
              <p data-testid="no-recent-matches" className="empty-note">
                No recent matches available.
              </p>
            ) : filteredMatches.length === 0 ? (
              <p data-testid="no-recent-matches-for-queue" className="empty-note">
                No recent matches in this queue.
              </p>
            ) : (
              <>
                <ul className="match-list" role="list">
                  {visibleMatches.map((match) => (
                    <MatchRow key={match.matchId} match={match} riotId={report.riotId} />
                  ))}
                </ul>
                {filteredMatches.length > visibleMatches.length ? (
                  <button
                    type="button"
                    className="btn btn-ghost match-list-more"
                    data-testid="recent-matches-load-more"
                    onClick={() => setVisibleCount((count) => count + RECENT_MATCHES_PAGE_SIZE)}
                  >
                    Load more
                  </button>
                ) : null}
              </>
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
      </div>
    </div>
  );
}
