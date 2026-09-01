import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ChampionMasteryEntry, ChampionSummary, PremadeEntry, RolePerformanceEntry } from '../api/types';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import { ChampionMasteryPanel } from './ChampionMasteryPanel';
import { ChampionPreferences } from './ChampionPreferences';
import { PremadesPanel } from './PremadesPanel';
import { RolePerformancePanel } from './RolePerformancePanel';

const champ = (championName: string, over: Partial<ChampionSummary> = {}): ChampionSummary => ({
  championName,
  gamesPlayed: 4,
  winRatePercent: 50,
  averageKda: 2.5,
  averageCs: 160,
  averageCsPerMinute: 5.5,
  ...over,
});

describe('ChampionPreferences', () => {
  it('renders one row per champion in the given order', () => {
    render(<ChampionPreferences champions={[champ('Ahri'), champ('Zed')]} />);
    const rows = screen.getAllByTestId(/^champion-(Ahri|Zed)$/);
    expect(rows.map((c) => (c.textContent?.includes('Ahri') ? 'Ahri' : 'Zed'))).toEqual(['Ahri', 'Zed']);
    expect(rows[0]).toHaveTextContent('4'); // games
    expect(rows[0]).toHaveTextContent('50%'); // win rate
  });

  it('shows the empty-state note for no champions', () => {
    render(<ChampionPreferences champions={[]} />);
    expect(screen.getByTestId('no-champions')).toBeInTheDocument();
  });
});

const VERSION = '16.17.1';
const CHAMPION_JSON = { data: { MonkeyKing: { name: 'Wukong', image: { full: 'MonkeyKing.png' }, key: '62' } } };

const masteryEntry = (championId: number, over: Partial<ChampionMasteryEntry> = {}): ChampionMasteryEntry => ({
  championId,
  championLevel: 7,
  championPoints: 250_000,
  gamesPlayed: 10,
  winRatePercent: 60,
  averageKda: 3.5,
  ...over,
});

function renderMasteryPanel(champions: ChampionMasteryEntry[]) {
  const provider = createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, CHAMPION_JSON, { data: {} }));
  return render(
    <StaticDataContext.Provider value={provider}>
      <ChampionMasteryPanel champions={champions} />
    </StaticDataContext.Provider>,
  );
}

describe('ChampionMasteryPanel', () => {
  it('renders one row per champion, resolving championId to the champion display name', () => {
    renderMasteryPanel([masteryEntry(62)]);
    const row = screen.getByTestId('champion-mastery-62');
    expect(row).toHaveTextContent('Wukong');
    expect(row).toHaveTextContent('10'); // games
    expect(row).toHaveTextContent('60%'); // win rate
  });

  it('shows mastery points formatted as x.xk / x.xm instead of KDA', () => {
    renderMasteryPanel([masteryEntry(62, { championPoints: 181_371 })]);
    const row = screen.getByTestId('champion-mastery-62');
    expect(row).toHaveTextContent('181.4k');
    expect(row).not.toHaveTextContent('KDA');
  });

  it('renders "—" for winRatePercent when null (no matches in the window)', () => {
    renderMasteryPanel([masteryEntry(62, { gamesPlayed: 0, winRatePercent: null, averageKda: null })]);
    const row = screen.getByTestId('champion-mastery-62');
    expect(row).toHaveTextContent('—');
    expect(row).not.toHaveTextContent('null');
  });

  it('shows the empty-state note for no champion mastery data', () => {
    render(<ChampionMasteryPanel champions={[]} />);
    expect(screen.getByTestId('no-champion-mastery')).toBeInTheDocument();
  });
});

const role = (r: string, over: Partial<RolePerformanceEntry> = {}): RolePerformanceEntry => ({
  role: r,
  gamesPlayed: 10,
  winRatePercent: 60,
  ...over,
});

describe('RolePerformancePanel', () => {
  it('renders one row per role with games and win rate', () => {
    render(<RolePerformancePanel roles={[role('MIDDLE'), role('JUNGLE', { gamesPlayed: 3, winRatePercent: 33 })]} />);
    expect(screen.getByTestId('role-perf-MIDDLE')).toHaveTextContent('MIDDLE');
    expect(screen.getByTestId('role-perf-MIDDLE')).toHaveTextContent('10');
    expect(screen.getByTestId('role-perf-MIDDLE')).toHaveTextContent('60%');
    expect(screen.getByTestId('role-perf-JUNGLE')).toHaveTextContent('33%');
  });

  it('shows the "not enough data" note for an empty slice (Requirement 8.5)', () => {
    render(<RolePerformancePanel roles={[]} />);
    expect(screen.getByTestId('no-role-performance')).toBeInTheDocument();
  });
});

const premade = (gameName: string, over: Partial<PremadeEntry> = {}): PremadeEntry => ({
  gameName,
  tagLine: 'EUW',
  gamesPlayed: 5,
  winRatePercent: 60,
  ...over,
});

describe('PremadesPanel', () => {
  it('renders one row per recurring teammate with games and win rate', () => {
    render(
      <MemoryRouter>
        <PremadesPanel premades={[premade('DuoBuddy'), premade('Trio', { gamesPlayed: 2, winRatePercent: 100 })]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('premade-DuoBuddy')).toHaveTextContent('DuoBuddy');
    expect(screen.getByTestId('premade-DuoBuddy')).toHaveTextContent('#EUW');
    expect(screen.getByTestId('premade-DuoBuddy')).toHaveTextContent('5');
    expect(screen.getByTestId('premade-DuoBuddy')).toHaveTextContent('60%');
    expect(screen.getByTestId('premade-Trio')).toHaveTextContent('100%');
    expect(screen.getByTestId('premade-DuoBuddy').querySelector('[data-testid="player-link"]')).toHaveAttribute(
      'href',
      '/profile?riotId=DuoBuddy%23EUW',
    );
  });

  it('shows the empty note when there are no recurring teammates', () => {
    render(<PremadesPanel premades={[]} />);
    expect(screen.getByTestId('no-premades')).toBeInTheDocument();
  });
});
