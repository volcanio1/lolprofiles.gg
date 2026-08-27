import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BuildPathOutcome } from '../api/lookupClient';
import { RIOT_ATTRIBUTION_TEXT, RiotDataPage } from '../compliance/RiotDataPage';
import { StaticDataContext, buildStaticDataIndex, createStaticDataProvider } from '../staticData';
import { BuildPathTab } from './BuildPathTab';

const fetchBuildPath = vi.fn<[string, { gameName: string; tagLine: string }], Promise<BuildPathOutcome>>();

vi.mock('../api/lookupClient', () => ({
  fetchBuildPath: (...args: [string, { gameName: string; tagLine: string }]) => fetchBuildPath(...args),
}));

const RID = { gameName: 'Faker', tagLine: 'KR1' };
const BUILD = { items: [0, 0, 0, 0, 0, 0], trinket: 0 } as const;

afterEach(() => {
  fetchBuildPath.mockReset();
});

describe('BuildPathTab', () => {
  it('fetches for the given match and Riot ID as soon as it mounts (i.e. tab selection)', () => {
    fetchBuildPath.mockReturnValue(new Promise(() => {}));
    render(<BuildPathTab matchId="EUW1_1" riotId={RID} finalBuild={BUILD} championName="Ahri" />);

    expect(fetchBuildPath).toHaveBeenCalledWith('EUW1_1', RID);
    expect(screen.getByTestId('loading-indicator')).toHaveTextContent('Loading build path');
  });

  it('renders the build path view once the fetch resolves', async () => {
    fetchBuildPath.mockResolvedValue({
      kind: 'build_path',
      buildPath: [{ itemId: 1055, timestamp: 11_000 }],
      skillOrder: [1, 2, 1],
      reconciled: true,
    });
    render(<BuildPathTab matchId="EUW1_1" riotId={RID} finalBuild={BUILD} championName="Ahri" />);

    expect(await screen.findByTestId('build-path-view')).toBeInTheDocument();
  });

  it('renders an in-tab message for an unavailable timeline', async () => {
    fetchBuildPath.mockResolvedValue({ kind: 'unavailable', reason: 'no_timeline' });
    render(<BuildPathTab matchId="EUW1_1" riotId={RID} finalBuild={BUILD} championName="Ahri" />);

    expect(await screen.findByTestId('build-path-EUW1_1-unavailable')).toHaveTextContent('not available');
  });

  it('renders an in-tab message on a transport error, never a page-level error', async () => {
    fetchBuildPath.mockResolvedValue({
      kind: 'error',
      error: { code: 'NETWORK_ERROR', message: 'offline', retriable: true },
    });
    render(<BuildPathTab matchId="EUW1_1" riotId={RID} finalBuild={BUILD} championName="Ahri" />);

    expect(await screen.findByTestId('build-path-EUW1_1-unavailable')).toHaveTextContent('could not be loaded');
  });

  it('does not set state after unmount when a slow response finally arrives', async () => {
    let resolve!: (value: BuildPathOutcome) => void;
    fetchBuildPath.mockReturnValue(new Promise<BuildPathOutcome>((r) => (resolve = r)));
    const { unmount } = render(<BuildPathTab matchId="EUW1_1" riotId={RID} finalBuild={BUILD} championName="Ahri" />);
    unmount();

    resolve({ kind: 'unavailable', reason: 'no_timeline' });
    await waitFor(() => expect(fetchBuildPath).toHaveBeenCalled());
    // No "not wrapped in act(...)" warning and no throw is the assertion here.
  });
});

describe('BuildPathTab — Riot compliance (Requirements 8.1, 8.2, 8.3)', () => {
  const provider = () =>
    createStaticDataProvider(
      '16.17.1',
      buildStaticDataIndex('16.17.1', { data: {} }, {
        data: { '1055': { name: "Doran's Blade", image: { full: '1055.png' }, gold: { total: 450 }, tags: [], into: [] } },
      }),
    );

  it('renders inside RiotDataPage with the attribution, no ad slot, and unmodified item images', async () => {
    fetchBuildPath.mockResolvedValue({
      kind: 'build_path',
      buildPath: [{ itemId: 1055, timestamp: 12_000 }],
      skillOrder: [1],
      reconciled: true,
    });

    const { container } = render(
      <RiotDataPage title="Profile report">
        <StaticDataContext.Provider value={provider()}>
          <BuildPathTab matchId="EUW1_1" riotId={RID} finalBuild={BUILD} championName="Ahri" />
        </StaticDataContext.Provider>
      </RiotDataPage>,
    );

    expect(await screen.findByTestId('build-path-view')).toBeInTheDocument();

    // 8.1: the page attribution covers the build path. 8.2: no advertising slot.
    expect(screen.getByTestId('riot-attribution')).toHaveTextContent(RIOT_ATTRIBUTION_TEXT);
    expect(screen.queryByTestId('advertising-slot')).not.toBeInTheDocument();

    // 8.3: the item image is served straight from Riot's CDN, unaltered.
    const img = container.querySelector('img.build-path-icon') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://ddragon.leagueoflegends.com/cdn/16.17.1/img/item/1055.png');
    expect(img.style.filter).toBe('');
  });
});
