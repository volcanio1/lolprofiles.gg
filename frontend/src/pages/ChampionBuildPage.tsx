/**
 * Champion build page (`/champion/:championKey?role=&rank=&region=`).
 *
 * champion-build-stats Requirements 3-8. Reads the champion key from the path and
 * the filters from the query string, guards an unknown key against the static
 * data index WITHOUT a backend request (Requirement 3.2), then renders the
 * champion's overall numbers, the filter bar, a freshness line, and one of the
 * five states from design.md — loading / error / not-enough-data / popular-only /
 * both panels.
 *
 *  - 3.3/3.4/6.5: `role` / `rank` / `region` live in the URL. `data.filtersApplied`
 *    (what the backend actually resolved and clamped) drives the controls, so a
 *    bad or absent value shows the backend's default without a special case here.
 *  - 3.6: a filter change is a `replace` (Back does not step through tweaks); a new
 *    champion is a push, done by whoever navigates here.
 *  - 3.5: rendered inside `RiotDataPage`; `SEO` names the champion and filters.
 *  - 8.2/8.3: the numbers are attributed as this site's own sample, and there is
 *    no control anywhere to trigger a crawl.
 */

import { useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ChampionBuildPanel } from '../components/ChampionBuildPanel';
import { ChampionIcon } from '../components/ChampionIcon';
import { ChampionStatsFilters, type ChampionStatsFiltersValue } from '../components/ChampionStatsFilters';
import { LoadingIndicator } from '../components/LoadingIndicator';
import { SEO } from '../components/SEO';
import { RiotDataPage } from '../compliance/RiotDataPage';
import {
  DEFAULT_RANK,
  DEFAULT_REGION,
  DEFAULT_ROLE,
  DISPLAY_FLOOR,
  MIN_SAMPLE,
  RANK_BUCKET_VALUES,
  ROLE_LABELS,
  ROLE_VALUES,
  type RankBucket,
  type Role,
} from '../domain/buildStatsConstants';
import { formatGameCount, formatRateToPercent, relativeAge } from '../domain/format';
import {
  useChampionBuildStats,
  type UseChampionBuildStatsOptions,
} from '../hooks/useChampionBuildStats';
import { useStaticData } from '../staticData';

export interface ChampionBuildPageProps {
  /** Injected in tests; production uses the real fetch. */
  championBuildStatsOptions?: UseChampionBuildStatsOptions;
  /** Injected in tests for a deterministic "updated N ago". */
  now?: () => number;
}

function isRole(value: string | null): value is Role {
  return value !== null && (ROLE_VALUES as readonly string[]).includes(value);
}
function isRank(value: string | null): value is RankBucket {
  return value !== null && (RANK_BUCKET_VALUES as readonly string[]).includes(value);
}

export function ChampionBuildPage({ championBuildStatsOptions, now = Date.now }: ChampionBuildPageProps = {}) {
  const { championKey = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const catalog = useStaticData().championCatalog();

  const indexReady = catalog !== null;
  const known = catalog !== null && Object.prototype.hasOwnProperty.call(catalog, championKey);

  const urlRole = searchParams.get('role');
  const urlRank = searchParams.get('rank');
  const urlRegion = searchParams.get('region');

  // The fetch carries whatever the URL says; an out-of-vocabulary value is
  // dropped so the endpoint applies its own default (Requirement 3.4).
  const fetchFilters = {
    role: isRole(urlRole) ? urlRole : undefined,
    rank: isRank(urlRank) ? urlRank : undefined,
    region: urlRegion ?? undefined,
  };

  const { data, status, error, retry } = useChampionBuildStats(
    known ? championKey : null,
    fetchFilters,
    championBuildStatsOptions,
  );

  const applyFilters = useCallback(
    (next: ChampionStatsFiltersValue) => {
      const params = new URLSearchParams();
      if (next.role !== DEFAULT_ROLE) params.set('role', next.role);
      if (next.rank !== DEFAULT_RANK) params.set('rank', next.rank);
      if (next.region !== DEFAULT_REGION) params.set('region', next.region);
      // Requirement 3.6: replace, so Back does not walk every filter tweak.
      setSearchParams(params, { replace: true });
    },
    [setSearchParams],
  );

  // --- states that render before (or instead of) the report -----------------

  if (!indexReady) {
    return (
      <RiotDataPage title="Champion build">
        <SEO title="Champion Builds" description="Champion build stats from this site's own sample of ranked games." noindex />
        <LoadingIndicator label="Loading…" />
      </RiotDataPage>
    );
  }

  if (!known) {
    return (
      <RiotDataPage title="Champion build">
        <SEO title="Unknown champion" description="No champion is known by that name." noindex />
        <p data-testid="unknown-champion" className="prompt">
          We don&rsquo;t recognise a champion called &ldquo;{championKey}&rdquo;.
        </p>
      </RiotDataPage>
    );
  }

  const roleForSeo = isRole(urlRole) ? urlRole : (data?.filtersApplied.role ?? DEFAULT_ROLE);
  const championName = data?.champion.name ?? championKey;
  const reportReady = status === 'ready' && data !== null;
  const enoughData =
    reportReady && data.popular !== null && data.meta.overall.totalGames >= DISPLAY_FLOOR;

  return (
    <RiotDataPage title="Champion build">
      <SEO
        title={roleForSeo === DEFAULT_ROLE ? `${championName} Build` : `${championName} ${ROLE_LABELS[roleForSeo]} Build`}
        description={`How ${championName} is built and how it performs — win rate, pick rate and two headline builds from this site's own sample of ranked games.`}
        noindex={!enoughData}
      />

      {status === 'loading' ? <LoadingIndicator label={`Loading ${championName} builds…`} /> : null}

      {status === 'error' && error !== null ? (
        <section role="alert" data-testid="champion-build-error" className="error-notice">
          <p className="error-body">{error.message}</p>
          <button type="button" className="btn btn-ghost" data-testid="champion-build-retry" onClick={retry}>
            Try again
          </button>
        </section>
      ) : null}

      {reportReady ? (
        <>
          <header className="champion-build-header">
            <ChampionIcon championKey={data.champion.key} size={48} />
            <div className="champion-build-header-figures">
              <span data-testid="champion-overall-win-rate">
                {formatRateToPercent(data.meta.overall.winRate)} win rate
              </span>
              <span data-testid="champion-overall-pick-rate">
                {formatRateToPercent(data.meta.overall.pickRate)} pick rate
              </span>
              <span data-testid="champion-overall-games">
                {formatGameCount(data.meta.overall.totalGames)} games
              </span>
            </div>
          </header>

          <ChampionStatsFilters meta={data.meta} value={data.filtersApplied} onChange={applyFilters} />

          <p className="champion-build-freshness" data-testid="champion-build-freshness">
            {data.meta.patch.length > 0 ? `Patch ${data.meta.patch} · ` : ''}
            {data.meta.lastUpdatedAt > 0 ? `updated ${relativeAge(data.meta.lastUpdatedAt, now())}` : 'not yet updated'}
            {' · '}this site&rsquo;s own sample of ranked games, not Riot data
          </p>

          {data.popular === null || data.meta.overall.totalGames < DISPLAY_FLOOR ? (
            <p data-testid="champion-not-enough-data" className="prompt">
              Not enough games recorded for these filters yet. Try widening the role, rank or region.
            </p>
          ) : (
            <div className="champion-build-panels">
              <ChampionBuildPanel
                label="Most popular"
                championKey={data.champion.key}
                build={data.popular}
              />
              {data.highestWinRate !== null ? (
                <ChampionBuildPanel
                  label="Highest win rate"
                  championKey={data.champion.key}
                  build={data.highestWinRate}
                  note={
                    data.highestWinRate.coreItems.join('-') === data.popular.coreItems.join('-')
                      ? 'This is also the most popular build.'
                      : undefined
                  }
                />
              ) : (
                <section className="champion-build-panel champion-build-panel--empty" aria-label="Highest win rate">
                  <h3 className="champion-build-panel-label">Highest win rate</h3>
                  <p data-testid="champion-no-min-sample" className="champion-build-missing">
                    No build has reached {formatGameCount(MIN_SAMPLE)} games at these filters yet.
                  </p>
                </section>
              )}
            </div>
          )}
        </>
      ) : null}
    </RiotDataPage>
  );
}
