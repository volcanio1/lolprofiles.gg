import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { MatchParticipant } from '../api/types';
import { GeneralTab, formatCompactNumber } from './GeneralTab';

const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;

function participant(overrides: Partial<MatchParticipant> = {}): MatchParticipant {
  return {
    isAnalyzedPlayer: false,
    isEnemyLaner: false,
    teamId: 100,
    riotIdGameName: 'Player',
    riotIdTagline: 'NA1',
    championName: 'Ahri',
    champLevel: 15,
    teamPosition: 'MIDDLE',
    summonerSpells: [4, 14],
    runes: { primaryStyle: 8100, secondaryStyle: 8000, primarySelections: [8112], secondarySelections: [8143], statShards: [5008, 5008, 5011] },
    build: { items: [3157, 0, 0, 0, 0, 0], trinket: 3340 },
    kills: 5,
    deaths: 3,
    assists: 8,
    cs: 210,
    visionScore: 22,
    damageToChampions: 24138,
    goldEarned: 12800,
    win: true,
    turretKills: 0,
    dragonKills: 0,
    baronKills: 0,
    pentaKills: 0,
    killParticipationPercent: 55,
    augments: [],
    ...overrides,
  };
}

function tenParticipants(): MatchParticipant[] {
  return [100, 200].flatMap((teamId) =>
    POSITIONS.map((position, i) =>
      participant({
        teamId,
        teamPosition: position,
        riotIdGameName: `${teamId === 100 ? 'Blue' : 'Red'}${String(i)}`,
        riotIdTagline: `T${String(i)}`,
        championName: `Champ${String(i)}`,
        isAnalyzedPlayer: teamId === 100 && i === 2,
        damageToChampions: (i + 1) * 5000,
      }),
    ),
  );
}

describe('formatCompactNumber', () => {
  it('abbreviates thousands (one decimal under 100k) and leaves small numbers alone', () => {
    expect(formatCompactNumber(24138)).toBe('24.1k');
    expect(formatCompactNumber(12800)).toBe('12.8k');
    expect(formatCompactNumber(950)).toBe('950');
    expect(formatCompactNumber(120000)).toBe('120k');
  });
});

describe('GeneralTab', () => {
  it('renders ten player rows split into two team tables', () => {
    render(<MemoryRouter><GeneralTab participants={tenParticipants()} durationSeconds={1800} /></MemoryRouter>);
    const rows = screen.getAllByRole('row').filter((row) => row.querySelector('th[scope="row"]'));
    expect(rows).toHaveLength(10);
  });

  it('shows the full name and tag, and the level with its label', () => {
    render(<MemoryRouter><GeneralTab participants={tenParticipants()} durationSeconds={1800} /></MemoryRouter>);
    const analyzed = screen.getByTestId(/scoreboard-row-100-Blue2/);
    expect(within(analyzed).getByText('Blue2')).toBeInTheDocument();
    expect(within(analyzed).getByText('#T2')).toBeInTheDocument();
    expect(within(analyzed).getByText('Lv 15')).toBeInTheDocument();
    expect(within(analyzed).getByText('You')).toBeInTheDocument();
  });

  it("links every player's tag to their own profile", () => {
    render(<MemoryRouter><GeneralTab participants={tenParticipants()} durationSeconds={1800} /></MemoryRouter>);
    const links = screen.getAllByTestId('player-link');
    expect(links).toHaveLength(10);
    expect(within(links[0]).getByText('Blue0')).toBeInTheDocument();
    expect(links[0]).toHaveAttribute('href', '/profile?riotId=Blue0%23T0');
  });

  it('gives every body row the same column count as the header', () => {
    render(<MemoryRouter><GeneralTab participants={tenParticipants()} durationSeconds={1800} /></MemoryRouter>);
    const table = screen.getAllByRole('table')[0];
    const headerCells = within(table).getAllByRole('columnheader');
    const firstBodyRow = within(table).getAllByRole('row').find((r) => r.querySelector('th[scope="row"]'))!;
    // champ + player + loadout + build + 5 numeric (KDA, CS, Dmg, KP, Score)
    expect(headerCells).toHaveLength(9);
    expect(firstBodyRow.querySelectorAll("th, td")).toHaveLength(9);
  });

  it('does not label the spells/runes column', () => {
    render(<MemoryRouter><GeneralTab participants={tenParticipants()} durationSeconds={1800} /></MemoryRouter>);
    expect(screen.queryByRole('columnheader', { name: 'Setup' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader', { name: /spells and runes/i }).length).toBeGreaterThan(0);
  });

  it('shows a colour-coded performance rating per player', () => {
    const players = tenParticipants();
    // Blue0 stomps, Red0 feeds.
    players[0] = participant({ ...players[0], kills: 15, deaths: 1, assists: 10, cs: 300, visionScore: 30, damageToChampions: 45000, goldEarned: 20000, killParticipationPercent: 75, turretKills: 4, dragonKills: 2, win: true });
    players[5] = participant({ ...players[5], kills: 0, deaths: 13, assists: 0, cs: 60, visionScore: 5, damageToChampions: 3000, goldEarned: 5000, killParticipationPercent: 10, win: false });

    const { container } = render(<MemoryRouter><GeneralTab participants={players} durationSeconds={1800} /></MemoryRouter>);

    const great = container.querySelector('.sb-rating--great');
    const bad = container.querySelector('.sb-rating--bad');
    expect(great).toBeInTheDocument();
    expect(bad).toBeInTheDocument();
    expect(Number(great?.textContent)).toBeGreaterThan(Number(bad?.textContent));
  });

  it('scales each damage bar to the match-wide top damage', () => {
    const { container } = render(<MemoryRouter><GeneralTab participants={tenParticipants()} durationSeconds={1800} /></MemoryRouter>);
    const fills = [...container.querySelectorAll('.sb-damage-bar-fill')] as HTMLElement[];
    // Red4 has the highest damage (5*5000=25000) -> 100%
    expect(fills.some((f) => f.style.width === '100%')).toBe(true);
    // Blue0 has 5000 -> 20%
    expect(fills.some((f) => f.style.width === '20%')).toBe(true);
  });
});
