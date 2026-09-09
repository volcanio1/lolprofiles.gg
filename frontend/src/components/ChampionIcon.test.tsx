import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import { ChampionIcon } from './ChampionIcon';

const VERSION = '16.17.1';
const CHAMPION_JSON = { data: { MonkeyKing: { name: 'Wukong', image: { full: 'MonkeyKing.png' }, key: '62' } } };

function renderIcon(ui: React.ReactElement) {
  const provider = createStaticDataProvider(VERSION, buildStaticDataIndex(VERSION, CHAMPION_JSON, { data: {} }));
  return render(
    <MemoryRouter>
      <StaticDataContext.Provider value={provider}>{ui}</StaticDataContext.Provider>
    </MemoryRouter>,
  );
}

describe('ChampionIcon', () => {
  it('links the champion name to its build page', () => {
    renderIcon(<ChampionIcon championKey="MonkeyKing" size={32} />);
    const link = screen.getByRole('link', { name: 'Wukong' });
    expect(link).toHaveAttribute('href', '/champion/MonkeyKing');
  });

  it('renders the name as plain text when linkName is false', () => {
    renderIcon(<ChampionIcon championKey="MonkeyKing" size={32} linkName={false} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Wukong')).toBeInTheDocument();
  });

  it('does not link an unresolved key (numeric-id fallback or newer patch)', () => {
    renderIcon(<ChampionIcon championKey="9999" size={32} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('9999')).toBeInTheDocument();
  });
});
