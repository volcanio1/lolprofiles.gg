import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from './App';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe('App routing', () => {
  it('renders the search page at "/"', () => {
    renderAt('/');

    expect(screen.getByRole('heading', { level: 1, name: 'Search a player' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Profile report' })).not.toBeInTheDocument();
  });

  it('renders the profile report page at "/profile"', () => {
    renderAt('/profile');

    expect(screen.getByRole('heading', { level: 1, name: 'Profile report' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Search a player' })).not.toBeInTheDocument();
  });

  it('renders the 404 page for any unmatched route', () => {
    renderAt('/no/such/page');

    expect(screen.getByRole('heading', { level: 1, name: 'No match' })).toBeInTheDocument();
    expect(screen.getByText("This route won’t resolve.")).toBeInTheDocument();
    expect(screen.getByText('/no/such/page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search a player' })).toBeInTheDocument();
  });
});
