import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunePage } from '../api/types';
import { RunePageCard } from './RunePageCard';

const PAGE: RunePage = {
  primaryStyle: 8100,
  secondaryStyle: 8000,
  primarySelections: [8112, 8126, 8138, 8135],
  secondarySelections: [9111, 8014],
  statShards: [5008, 5008, 5001],
};

function renderCard(props: Partial<Parameters<typeof RunePageCard>[0]> = {}) {
  return render(<RunePageCard runes={PAGE} championKey="Jinx" testId="rp" {...props} />);
}

describe('RunePageCard', () => {
  it('renders the three rune groups from a full page', () => {
    renderCard();
    expect(screen.getByTestId('rp')).toBeInTheDocument();
    expect(document.querySelector('.rune-group--primary')).toBeInTheDocument();
    expect(document.querySelector('.rune-group--secondary')).toBeInTheDocument();
    expect(document.querySelector('.rune-group--shards')).toBeInTheDocument();
    expect(screen.queryByTestId('rp-unavailable')).not.toBeInTheDocument();
  });

  it('shows its own unavailable branch for a null page (Requirement 7.3)', () => {
    renderCard({ runes: null, unavailableText: 'Not enough data for a rune page.' });
    expect(screen.getByTestId('rp-unavailable')).toHaveTextContent('Not enough data for a rune page.');
    expect(document.querySelector('.rune-group--primary')).not.toBeInTheDocument();
  });

  it('shows the unavailable branch for an empty page Riot never reported', () => {
    renderCard({
      runes: { primaryStyle: 0, secondaryStyle: 0, primarySelections: [], secondarySelections: [], statShards: [0, 0, 0] },
    });
    expect(screen.getByTestId('rp-unavailable')).toBeInTheDocument();
  });

  it('adds the You badge and highlight only for the analyzed variant', () => {
    const { rerender } = renderCard({ variant: 'analyzed' });
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(document.querySelector('.rune-page-card--analyzed')).toBeInTheDocument();
    rerender(<RunePageCard runes={PAGE} championKey="Jinx" testId="rp" variant="default" />);
    expect(screen.queryByText('You')).not.toBeInTheDocument();
  });
});
