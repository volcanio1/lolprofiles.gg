import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SkillOrderView, maxOrder } from './SkillOrderView';

// Q W Q E Q R Q W Q W R W W E E R E  (17 level-ups)
const ORDER = [1, 2, 1, 3, 1, 4, 1, 2, 1, 2, 4, 2, 2, 3, 3, 4, 3];

describe('maxOrder', () => {
  it('ranks Q/W/E by the level at which each reached 5 points; R is not ranked', () => {
    // Q's 5th point is at index 8, W's 5th at index 12, E never reaches 5.
    expect(maxOrder(ORDER)).toEqual({ 1: 1, 2: 2 });
  });

  it('is empty when nothing was maxed', () => {
    expect(maxOrder([1, 2, 3, 4])).toEqual({});
  });
});

describe('SkillOrderView', () => {
  it('renders a Q/W/E/R tile row and a grid cell for every level-up', () => {
    render(<SkillOrderView championName="Orianna" skillOrder={ORDER} />);

    expect(screen.getByTestId('skill-order')).toBeInTheDocument();

    // Grid: 4 ability rows, one filled cell per level-up.
    const filled = document.querySelectorAll('.skill-order-grid-cell--on');
    expect(filled).toHaveLength(ORDER.length);
    // First level-up was Q (slot 1), so row Q column 1 is filled with "1".
    const qRow = screen.getByRole('row', { name: /^Q/ });
    expect(within(qRow).getAllByText('1')[0]).toBeInTheDocument();
  });

  it('shows the max-order badge on the abilities that were maxed', () => {
    render(<SkillOrderView championName="Orianna" skillOrder={ORDER} />);
    expect(screen.getByLabelText('maxed 1')).toBeInTheDocument();
    expect(screen.getByLabelText('maxed 2')).toBeInTheDocument();
  });

  it('renders nothing when there is no skill data', () => {
    const { container } = render(<SkillOrderView championName="Orianna" skillOrder={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to Q/W/E/R letters when the champion abilities do not load', () => {
    // No StaticDataContext provider -> version is null -> no fetch -> letter tiles.
    render(<SkillOrderView championName="Orianna" skillOrder={ORDER} />);
    const tiles = screen.getByRole('list');
    expect(within(tiles).getByLabelText('Q ability')).toBeInTheDocument();
  });
});
