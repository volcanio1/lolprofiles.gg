import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import type { BuildPathEntry, ItemBuild } from '../api/types';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import { BuildPathView, formatMatchTime } from './BuildPathView';

const VERSION = '16.17.1';

const ITEM_JSON = {
  data: {
    // completed: gold > 0, not consumable/trinket, no `into`
    '1055': { name: "Doran's Blade", image: { full: '1055.png' }, gold: { total: 450 }, tags: ['Damage'], into: [] },
    // component: builds into 1055
    '1036': { name: 'Long Sword', image: { full: '1036.png' }, gold: { total: 350 }, tags: ['Damage'], into: ['1055'] },
    // completed
    '3078': { name: 'Trinity Force', image: { full: '3078.png' }, gold: { total: 3333 }, tags: ['Damage'], depth: 3 },
    // consumable
    '2003': { name: 'Health Potion', image: { full: '2003.png' }, gold: { total: 50 }, tags: ['Consumable'] },
  },
};

function readyProvider() {
  return createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, { data: {} }, ITEM_JSON));
}

function renderReady(ui: ReactElement) {
  return render(<StaticDataContext.Provider value={readyProvider()}>{ui}</StaticDataContext.Provider>);
}

const PATH: BuildPathEntry[] = [
  { itemId: 2003, timestamp: 11_000 },
  { itemId: 1036, timestamp: 65_000, soldAt: 600_000 },
  { itemId: 1055, timestamp: 90_000 },
  { itemId: 3078, timestamp: 480_000 },
];

const BUILD: ItemBuild = { items: [1055, 3078, 0, 0, 0, 0], trinket: 3340 };

describe('formatMatchTime', () => {
  it('renders milliseconds-from-start as M:SS, not wrapping the minutes', () => {
    expect(formatMatchTime(0)).toBe('0:00');
    expect(formatMatchTime(11_000)).toBe('0:11');
    expect(formatMatchTime(65_000)).toBe('1:05');
    expect(formatMatchTime(3_661_000)).toBe('61:01');
  });

  it('clamps a negative or non-finite value to 0:00', () => {
    expect(formatMatchTime(-5)).toBe('0:00');
    expect(formatMatchTime(Number.NaN)).toBe('0:00');
  });
});

describe('BuildPathView', () => {
  it('shows a start-trinket node, then buys and a sell marker merged in time order', () => {
    renderReady(<BuildPathView buildPath={PATH} reconciled finalBuild={BUILD} />);

    const nodes = screen.getAllByRole('listitem');
    // start node + 4 buys + 1 sell marker (Long Sword sold at 10:00)
    expect(nodes).toHaveLength(6);
    expect(within(nodes[0]).getByText('start')).toBeInTheDocument();
    expect(within(nodes[1]).getByText('0:11')).toBeInTheDocument(); // buy Health Potion
    expect(within(nodes[4]).getByText('8:00')).toBeInTheDocument(); // buy Trinity Force
    expect(nodes[5]).toHaveClass('build-path-node--sold'); // sell marker is last (10:00)
    expect(within(nodes[5]).getByText('10:00')).toBeInTheDocument();
  });

  it('defaults the start trinket to the yellow Stealth Ward, but shows an early swap instead', () => {
    renderReady(<BuildPathView buildPath={PATH} reconciled />);
    // 3340 = Stealth Ward; unresolved in this fixture, so its placeholder labels it.
    const start = screen.getByText('start').closest('li') as HTMLElement;
    expect(within(start).getByLabelText(/3340/)).toBeInTheDocument();

    // A Farsight (3363) bought at 0:04 is the chosen starting trinket, folded into
    // the start node rather than shown inline.
    const withSwap: BuildPathEntry[] = [{ itemId: 3363, timestamp: 4000 }, ...PATH];
    renderReady(<BuildPathView buildPath={withSwap} reconciled />);
    const start2 = screen.getAllByText('start')[1].closest('li') as HTMLElement;
    expect(within(start2).getByLabelText(/3363/)).toBeInTheDocument();
  });

  it('renders a sold item twice: a buy node at the buy time and a sell marker at the sell time', () => {
    renderReady(<BuildPathView buildPath={PATH} reconciled />);

    // buy node at 1:05 (65_000ms), not marked sold
    const buys = screen.getAllByText('1:05');
    expect(buys[0].closest('li')).not.toHaveClass('build-path-node--sold');

    // separate sell marker at 10:00 (600_000ms)
    const sellMarker = screen.getByText('sold').closest('li') as HTMLElement;
    expect(sellMarker).toHaveClass('build-path-node--sold');
    expect(within(sellMarker).getByText('10:00')).toBeInTheDocument();
  });

  it('appends a final-trinket node only when it differs from the start', () => {
    renderReady(<BuildPathView buildPath={PATH} reconciled finalBuild={{ items: BUILD.items, trinket: 3364 }} />);

    const finalNode = screen.getByText('final').closest('li');
    expect(finalNode).toHaveClass('build-path-node--trinket');
    expect(within(finalNode as HTMLElement).getByLabelText(/3364/)).toBeInTheDocument();
  });

  it('collapses to legendary items only when toggled, then back', async () => {
    renderReady(<BuildPathView buildPath={PATH} reconciled finalBuild={BUILD} />);

    await userEvent.click(screen.getByRole('button', { name: 'Legendary items only' }));
    // start node + buy 1055 + buy 3078; potion, Long Sword and its sell marker hidden
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText('0:11')).not.toBeInTheDocument();
    expect(screen.queryByText('sold')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show all items' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
  });

  it('keeps an unresolvable item id in place with the raw id as its label', () => {
    render(<BuildPathView buildPath={[{ itemId: 999999, timestamp: 1000 }]} reconciled />);

    expect(screen.getByLabelText('999999 unavailable')).toBeInTheDocument();
    expect(screen.getByText('0:01')).toBeInTheDocument();
  });

  it('shows the unreconciled caveat but still renders the path', () => {
    renderReady(<BuildPathView buildPath={PATH} reconciled={false} />);

    expect(screen.getByTestId('build-path-caveat')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('shows the full path and no toggle before the provider is ready', () => {
    render(<BuildPathView buildPath={PATH} reconciled />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(6); // start node + 4 buys + 1 sell marker
  });
});
