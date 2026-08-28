import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GamemodeFilter } from './GamemodeFilter';

describe('GamemodeFilter', () => {
  it('renders one tab per provided value, with the current one selected', () => {
    render(
      <GamemodeFilter
        value="ranked solo/duo"
        onChange={() => {}}
        availableValues={['all', 'ranked solo/duo', 'normal']}
        label="Filter by queue"
        testId="f"
      />,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['All', 'Solo', 'Normal']);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('reports the clicked value through onChange', () => {
    const onChange = vi.fn();
    render(
      <GamemodeFilter
        value="all"
        onChange={onChange}
        availableValues={['all', 'ranked solo/duo', 'normal']}
        label="Filter by queue"
        testId="f"
      />,
    );
    fireEvent.click(screen.getByTestId('f-ranked-solo-duo'));
    expect(onChange).toHaveBeenCalledWith('ranked solo/duo');
  });
});
