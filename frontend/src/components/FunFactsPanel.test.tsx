import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FunFactV2 } from '../api/types';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import { FunFactsPanel } from './FunFactsPanel';

const VERSION = '16.17.1';
const ITEM_JSON = {
  data: {
    3157: { name: 'Zhonya’s Hourglass', image: { full: '3157.png' } },
  },
};

function renderPanel(funFacts: FunFactV2[], limitedDataNotice = false) {
  const provider = createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, { data: {} }, ITEM_JSON));
  return render(
    <StaticDataContext.Provider value={provider}>
      <FunFactsPanel funFacts={funFacts} limitedDataNotice={limitedDataNotice} />
    </StaticDataContext.Provider>,
  );
}

describe('FunFactsPanel', () => {
  it('renders one item per fact, in the order given', () => {
    renderPanel([
      { category: 'nemesis', text: 'Your nemesis: Zed.' },
      { category: 'longestGame', text: 'Longest game: 45m 00s.' },
    ]);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.dataset.testid)).toEqual(['fun-fact-nemesis', 'fun-fact-longestGame']);
  });

  it('renders favorite items as a list of resolved names, not raw ids, only on the favoriteItems category', () => {
    renderPanel([
      { category: 'nemesis', text: 'Your nemesis: Zed.' },
      {
        category: 'favoriteItems',
        text: 'Your most-built items across your recent games:',
        favoriteItems: [{ itemId: 3157, count: 3 }],
      },
    ]);
    const list = screen.getByTestId('favorite-item-icons');
    expect(list).toBeInTheDocument();
    expect(list).toHaveTextContent('Zhonya’s Hourglass');
    expect(list).not.toHaveTextContent('3157');
    const nemesisItem = screen.getByTestId('fun-fact-nemesis');
    expect(nemesisItem.querySelector('[data-testid="favorite-item-icons"]')).toBeNull();
  });

  it('renders averageKda and averageGoldDiffAt10 with their own labels', () => {
    renderPanel([
      { category: 'averageKda', text: 'Average KDA: 3.25 across 12 games.' },
      { category: 'averageGoldDiffAt10', text: 'Average gold diff @ 10: +150 gold.' },
    ]);
    const kdaItem = screen.getByTestId('fun-fact-averageKda');
    expect(kdaItem).toHaveTextContent('Average KDA');
    expect(kdaItem).toHaveTextContent('3.25');
    const goldDiffItem = screen.getByTestId('fun-fact-averageGoldDiffAt10');
    expect(goldDiffItem).toHaveTextContent('Average gold diff @ 10');
    expect(goldDiffItem).toHaveTextContent('+150');
  });

  it('shows the limited-data phrasing when limitedDataNotice is set and there are no facts', () => {
    renderPanel([], true);
    expect(screen.getByTestId('no-fun-facts')).toHaveTextContent(/not enough match history/i);
  });

  it('shows a plain empty phrasing when there is enough data but nothing to report', () => {
    renderPanel([], false);
    expect(screen.getByTestId('no-fun-facts')).toHaveTextContent(/nothing to report/i);
  });
});
