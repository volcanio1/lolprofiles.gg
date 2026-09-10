import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunePage } from '../api/types';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import { RunePageDiagram } from './RunePageDiagram';

const VERSION = '16.17.1';

/** Minimal `runesReforged.json`: two trees, keystone row + three minor rows each. */
const RUNES_JSON = [
  {
    id: 8000,
    key: 'Precision',
    name: 'Precision',
    icon: 'perk-images/Styles/7201_Precision.png',
    slots: [
      { runes: [rune(8005, 'Press the Attack'), rune(8008, 'Lethal Tempo'), rune(8021, 'Fleet Footwork'), rune(8010, 'Conqueror')] },
      { runes: [rune(9101, 'Absorb Life'), rune(9111, 'Triumph'), rune(8009, 'Presence of Mind')] },
      { runes: [rune(9104, 'Legend: Alacrity'), rune(9105, 'Legend: Haste'), rune(9103, 'Legend: Bloodline')] },
      { runes: [rune(8014, 'Coup de Grace'), rune(8017, 'Cut Down'), rune(8299, 'Last Stand')] },
    ],
  },
  {
    id: 8100,
    key: 'Domination',
    name: 'Domination',
    icon: 'perk-images/Styles/7200_Domination.png',
    slots: [
      { runes: [rune(8112, 'Electrocute'), rune(8124, 'Predator'), rune(8128, 'Dark Harvest'), rune(9923, 'Hail of Blades')] },
      { runes: [rune(8126, 'Cheap Shot'), rune(8139, 'Taste of Blood'), rune(8143, 'Sudden Impact')] },
      { runes: [rune(8136, 'Zombie Ward'), rune(8120, 'Ghost Poro'), rune(8138, 'Eyeball Collection')] },
      { runes: [rune(8135, 'Treasure Hunter'), rune(8134, 'Ingenious Hunter'), rune(8105, 'Relentless Hunter'), rune(8106, 'Ultimate Hunter')] },
    ],
  },
];

function rune(id: number, name: string) {
  return { id, key: name.replace(/\s+/g, ''), name, icon: `perk-images/rune${String(id)}.png`, shortDesc: name, longDesc: name };
}

const PAGE: RunePage = {
  primaryStyle: 8100,
  secondaryStyle: 8000,
  primarySelections: [8112, 8126, 8138, 8135],
  secondarySelections: [9111, 8014],
  statShards: [5008, 5010, 5011],
};

function renderDiagram(runes: RunePage | null, withStructure = true) {
  const provider = createStaticDataProvider(
    VERSION,
    buildStaticDataIndex(VERSION, { data: {} }, { data: {} }, undefined, withStructure ? RUNES_JSON : undefined),
  );
  return render(
    <StaticDataContext.Provider value={provider}>
      <RunePageDiagram runes={runes} testId="rp" />
    </StaticDataContext.Provider>,
  );
}

describe('RunePageDiagram', () => {
  it('draws the full page: every rune in both trees, not just the picks', () => {
    renderDiagram(PAGE);
    const diagram = screen.getByTestId('rp');
    // Domination primary tree has 4 + 3 + 3 + 4 = 14 runes; Precision secondary
    // contributes its three minor rows (3 + 3 + 3 = 9). 23 rune images total.
    const runeImgs = within(diagram)
      .getAllByRole('img')
      .filter((img) => (img.getAttribute('alt') ?? '').length > 0);
    expect(runeImgs.length).toBeGreaterThanOrEqual(23);
    expect(diagram.querySelector('.rune-diagram-tree--primary')).toBeInTheDocument();
    expect(diagram.querySelector('.rune-diagram-tree--secondary')).toBeInTheDocument();
  });

  it('lights the picked runes and dims the rest', () => {
    renderDiagram(PAGE);
    const diagram = screen.getByTestId('rp');
    const on = diagram.querySelectorAll('.rune-cell--on');
    const off = diagram.querySelectorAll('.rune-cell--off');
    // 4 primary + 2 secondary + 3 shards picked.
    expect(on.length).toBe(9);
    expect(off.length).toBeGreaterThan(9);
  });

  it('renders the keystone row with its own class', () => {
    renderDiagram(PAGE);
    expect(screen.getByTestId('rp').querySelector('.rune-diagram-row--keystone')).toBeInTheDocument();
  });

  it('shows the three stat-shard rows', () => {
    renderDiagram(PAGE);
    expect(screen.getByTestId('rp').querySelectorAll('.rune-diagram-row--shard')).toHaveLength(3);
  });

  it('falls back to picked-runes-only when no tree structure is available', () => {
    renderDiagram(PAGE, false);
    const diagram = screen.getByTestId('rp');
    expect(diagram).toHaveClass('rune-diagram--compact');
    expect(diagram.querySelector('.rune-group--primary')).toBeInTheDocument();
    expect(diagram.querySelector('.rune-diagram-row--keystone')).not.toBeInTheDocument();
  });

  it('shows its own unavailable branch for a null page (Requirement 7.3)', () => {
    renderDiagram(null);
    expect(screen.getByTestId('rp-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('rp')).not.toBeInTheDocument();
  });
});
