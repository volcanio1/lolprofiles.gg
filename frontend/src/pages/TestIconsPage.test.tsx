import { render, screen } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { describe, expect, it } from 'vitest';
import { TestIconsPage } from './TestIconsPage';

/** Smoke test only — the page is a manual inspection aid, not a product surface. */
describe('TestIconsPage', () => {
  it('lists every parsed stat name with its icon key', () => {
    render(
      <HelmetProvider>
        <TestIconsPage />
      </HelmetProvider>,
    );

    expect(screen.getByRole('rowheader', { name: 'Attack Damage' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Lethality' })).toBeInTheDocument();
    // Lethality now shares the armor-penetration icon.
    expect(screen.getAllByText('armor-pen').length).toBeGreaterThanOrEqual(2);
  });
});
