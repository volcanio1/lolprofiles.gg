import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('renders name -> stats -> description, with a stat glyph per stat line', () => {
    render(
      <Tooltip
        title="Infinity Edge"
        description={{
          stats: [
            { amount: '65', stat: 'Attack Damage' },
            { amount: '25%', stat: 'Critical Strike Chance' },
          ],
          paragraphs: ['Critical strikes deal bonus damage.'],
        }}
      >
        <span>icon</span>
      </Tooltip>,
    );
    const anchor = screen.getByTestId('tooltip-anchor');

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(anchor);

    const bubble = screen.getByRole('tooltip');
    const order = bubble.textContent ?? '';
    expect(order.indexOf('Infinity Edge')).toBeLessThan(order.indexOf('Attack Damage'));
    expect(order.indexOf('Attack Damage')).toBeLessThan(order.indexOf('Critical strikes deal bonus damage.'));
    expect(bubble.querySelectorAll('.tooltip-stat-row')).toHaveLength(2);
    expect(bubble.querySelectorAll('.tooltip-stat-icon-slot')).toHaveLength(2);
    expect(anchor).toHaveAttribute('aria-describedby', bubble.getAttribute('id'));

    fireEvent.mouseLeave(anchor);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('shows a title-only tooltip on focus and dismisses on Escape', () => {
    render(
      <Tooltip title="Domination">
        <span>icon</span>
      </Tooltip>,
    );
    const anchor = screen.getByTestId('tooltip-anchor');

    fireEvent.focus(anchor);
    const bubble = screen.getByRole('tooltip');
    expect(bubble).toHaveTextContent('Domination');
    expect(bubble.querySelector('.tooltip-stats')).toBeNull();
    expect(bubble.querySelector('.tooltip-body')).toBeNull();

    fireEvent.keyDown(anchor, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('renders children without an anchor when there is no title', () => {
    render(
      <Tooltip title="">
        <span>bare</span>
      </Tooltip>,
    );
    expect(screen.queryByTestId('tooltip-anchor')).not.toBeInTheDocument();
    expect(screen.getByText('bare')).toBeInTheDocument();
  });

  it('renders `body` in place of `description`, when given', () => {
    render(
      <Tooltip
        title="Custom"
        body={
          <span style={{ color: 'red' }} data-testid="custom-line">
            custom content
          </span>
        }
      >
        <span>icon</span>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByTestId('tooltip-anchor'));

    const bubble = screen.getByRole('tooltip');
    expect(bubble).toHaveTextContent('Custom');
    const line = screen.getByTestId('custom-line');
    expect(line).toHaveTextContent('custom content');
    expect(line).toHaveStyle({ color: 'rgb(255, 0, 0)' });
    expect(bubble.querySelector('.tooltip-stats')).toBeNull();
  });
});
