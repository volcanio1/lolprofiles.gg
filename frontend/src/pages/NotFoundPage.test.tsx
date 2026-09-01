import { render, screen, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NotFoundPage } from './NotFoundPage';

function Location() {
  return <span data-testid="loc">{useLocation().pathname}</span>;
}

function renderAt(path: string, { withLocation = false } = {}) {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/', path]} initialIndex={1}>
        {withLocation ? <Location /> : null}
        <Routes>
          <Route path="/" element={<span>search page</span>} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe('NotFoundPage', () => {
  it('shows the requested path and the 404 result in the trace', () => {
    renderAt('/champs/aatrox/builds');

    expect(screen.getByRole('heading', { level: 1, name: 'No match' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getByText('/champs/aatrox/builds')).toBeInTheDocument();
    expect(within(main).getByText('404')).toBeInTheDocument();
  });

  it('truncates a pathological path', () => {
    renderAt(`/${'x'.repeat(80)}`);
    expect(within(screen.getByRole('main')).getByText(/…$/)).toBeInTheDocument();
  });

  it('routes to search from the primary action', async () => {
    renderAt('/nope', { withLocation: true });
    await userEvent.click(screen.getByRole('button', { name: 'Search a player' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/');
    expect(screen.getByText('search page')).toBeInTheDocument();
  });

  it('hides "Go back" on a direct load (no prior history entry)', () => {
    window.history.replaceState(null, '');
    renderAt('/nope');
    expect(screen.queryByRole('button', { name: 'Go back' })).not.toBeInTheDocument();
  });

  it('shows "Go back" when history state records a prior entry', () => {
    window.history.replaceState({ idx: 3 }, '');
    renderAt('/nope');
    expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
  });

  it('keeps the Riot attribution on screen', () => {
    renderAt('/nope');
    expect(screen.getByTestId('riot-attribution')).toBeInTheDocument();
  });
});
