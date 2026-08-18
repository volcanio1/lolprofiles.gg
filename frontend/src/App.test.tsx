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
});
