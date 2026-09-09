import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import type { ChampionCoreItemSlot } from '../api/types';
import { CoreItemsRow } from './CoreItemsRow';

const VERSION = '16.17.1';
const ITEM_JSON = {
  data: {
    3006: { name: 'Berserker’s Greaves', image: { full: '3006.png' } },
    3031: { name: 'Infinity Edge', image: { full: '3031.png' } },
    3094: { name: 'Rapid Firecannon', image: { full: '3094.png' } },
  },
};

function renderRow(slots: ChampionCoreItemSlot[]) {
  const provider = createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, { data: {} }, ITEM_JSON));
  return render(
    <StaticDataContext.Provider value={provider}>
      <CoreItemsRow slots={slots} />
    </StaticDataContext.Provider>,
  );
}

describe('CoreItemsRow', () => {
  it('renders one ordered slot per position, resolving known items to an icon', () => {
    renderRow([[3006], [3031]]);
    const list = screen.getByTestId('core-items');
    expect(list.tagName).toBe('OL');
    const icons = list.querySelectorAll('img');
    expect(icons).toHaveLength(2);
    expect(icons[0]).toHaveAttribute('alt', 'Berserker’s Greaves');
    expect(list.querySelectorAll('.core-items-slot')).toHaveLength(2);
  });

  it('renders a two-option slot as "A / B"', () => {
    renderRow([[3031, 3094], [3006]]);
    const list = screen.getByTestId('core-items');
    expect(list.querySelectorAll('img')).toHaveLength(3);
    expect(list.textContent).toContain('/');
    expect(list.querySelectorAll('.core-items-or')).toHaveLength(1);
  });

  it('degrades an unresolvable id to a placeholder rather than a broken image', () => {
    renderRow([[999999]]);
    expect(screen.getByTestId('core-items').querySelectorAll('img')).toHaveLength(0);
  });

  it('renders nothing for an empty path', () => {
    const { container } = renderRow([]);
    expect(container).toBeEmptyDOMElement();
  });
});
