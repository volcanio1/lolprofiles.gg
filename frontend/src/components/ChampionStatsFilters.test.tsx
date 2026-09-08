import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ChampionStatsMeta } from '../api/types';
import { ChampionStatsFilters, type ChampionStatsFiltersValue } from './ChampionStatsFilters';

function meta(overrides: Partial<ChampionStatsMeta> = {}): ChampionStatsMeta {
  return {
    patch: '16.17',
    lastUpdatedAt: 1_700_000_000_000,
    availableRoles: ['ALL', 'MIDDLE', 'BOTTOM'],
    defaultRole: 'BOTTOM',
    availableRanks: ['ALL', 'EMERALD_PLUS', 'DIAMOND_PLUS'],
    defaultRank: 'ALL',
    availableRegions: ['world'],
    overall: { winRate: 0.5, pickRate: 0.2, totalGames: 5000 },
    ...overrides,
  };
}

const value: ChampionStatsFiltersValue = { role: 'BOTTOM', rank: 'ALL', region: 'world' };

function renderFilters(props: Partial<Parameters<typeof ChampionStatsFilters>[0]> = {}) {
  const onChange = vi.fn();
  render(<ChampionStatsFilters meta={meta()} value={value} onChange={onChange} {...props} />);
  return { onChange };
}

describe('ChampionStatsFilters', () => {
  it('populates each control from meta.available*, using site role labels not teamPosition', () => {
    renderFilters();
    const role = screen.getByTestId('champion-filter-role');
    expect([...role.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['All roles', 'Mid', 'Bottom']);
    expect(role).not.toHaveTextContent('MIDDLE');
    expect([...screen.getByTestId('champion-filter-rank').querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'All ranks',
      'Emerald+',
      'Diamond+',
    ]);
  });

  it('disables a control the backend advertises only one option for (Requirement 6.3)', () => {
    renderFilters();
    expect(screen.getByTestId('champion-filter-region')).toBeDisabled();
    expect(screen.getByTestId('champion-filter-role')).toBeEnabled();
  });

  it('emits the merged filter object on a change', async () => {
    const user = userEvent.setup();
    const { onChange } = renderFilters();
    await user.selectOptions(screen.getByTestId('champion-filter-role'), 'MIDDLE');
    expect(onChange).toHaveBeenCalledWith({ role: 'MIDDLE', rank: 'ALL', region: 'world' });
  });

  it('stays controlled and disabled when meta advertises no options yet (empty-state)', () => {
    renderFilters({ meta: meta({ availableRoles: [], availableRanks: [], availableRegions: [] }) });
    const role = screen.getByTestId('champion-filter-role');
    expect(role).toBeDisabled();
    expect((role as HTMLSelectElement).value).toBe('BOTTOM');
  });
});
