/**
 * The Role / Rank / Region filter bar for the champion build page
 * (champion-build-stats Requirement 6).
 *
 * Stateless: `ChampionBuildPage` owns the values (in the URL) and the defaults.
 * Every option set comes from the response `meta` — nothing here is hard-coded
 * (Requirement 6.2), so the backend can add a rank bucket or a region without a
 * frontend change. A control the backend advertises only one option for renders
 * disabled, not hidden (Requirement 6.3). Role options use the site's role
 * vocabulary, not raw `teamPosition` strings (Requirement 6.6).
 */

import { useId } from 'react';
import type {
  ChampionStatsMeta,
  ChampionStatsRankBucket,
  ChampionStatsRole,
} from '../api/types';
import { RANK_BUCKET_LABELS, ROLE_LABELS, regionLabel } from '../domain/buildStatsConstants';

export interface ChampionStatsFiltersValue {
  role: ChampionStatsRole;
  rank: ChampionStatsRankBucket;
  region: string;
}

export interface ChampionStatsFiltersProps {
  meta: ChampionStatsMeta;
  value: ChampionStatsFiltersValue;
  onChange: (next: ChampionStatsFiltersValue) => void;
}

interface FilterSelectProps<T extends string> {
  label: string;
  testId: string;
  options: readonly T[];
  labelOf: (option: T) => string;
  value: T;
  onChange: (next: T) => void;
}

function FilterSelect<T extends string>({
  label,
  testId,
  options,
  labelOf,
  value,
  onChange,
}: FilterSelectProps<T>) {
  const id = useId();
  // Requirement 6.3: one option (or none advertised yet) -> disabled, not hidden.
  const selectable = options.length > 1;
  const rendered = options.length > 0 ? options : [value];

  return (
    <div className="champion-stats-filter">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <select
        id={id}
        data-testid={testId}
        className="field-input"
        value={value}
        disabled={!selectable}
        onChange={(event) => {
          onChange(event.target.value as T);
        }}
      >
        {rendered.map((option) => (
          <option key={option} value={option}>
            {labelOf(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ChampionStatsFilters({ meta, value, onChange }: ChampionStatsFiltersProps) {
  return (
    <div className="champion-stats-filters" data-testid="champion-stats-filters">
      <FilterSelect
        label="Role"
        testId="champion-filter-role"
        options={meta.availableRoles}
        labelOf={(role) => ROLE_LABELS[role]}
        value={value.role}
        onChange={(role) => {
          onChange({ ...value, role });
        }}
      />
      <FilterSelect
        label="Rank"
        testId="champion-filter-rank"
        options={meta.availableRanks}
        labelOf={(rank) => RANK_BUCKET_LABELS[rank]}
        value={value.rank}
        onChange={(rank) => {
          onChange({ ...value, rank });
        }}
      />
      <FilterSelect
        label="Region"
        testId="champion-filter-region"
        options={meta.availableRegions}
        labelOf={regionLabel}
        value={value.region}
        onChange={(region) => {
          onChange({ ...value, region });
        }}
      />
    </div>
  );
}
