import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaticDataContextProvider, useStaticData } from './StaticDataContext';
import { clearStoredIndex } from './cache';

/** Task 2.1 — Requirements 4.4, 4.5, 4.6, 5.2. */

function Probe() {
  const provider = useStaticData();
  return (
    <div>
      <span data-testid="ready">{String(provider.ready)}</span>
      <span data-testid="version">{provider.version ?? 'none'}</span>
      <span data-testid="name">{provider.championDisplayName('MonkeyKing')}</span>
      <span data-testid="icon">{provider.championIconUrl('MonkeyKing') ?? 'null'}</span>
      <span data-testid="key-for-id">{provider.championKeyForId(62) ?? 'null'}</span>
    </div>
  );
}

const CHAMPION_JSON = { data: { MonkeyKing: { name: 'Wukong', image: { full: 'MonkeyKing.png' }, key: '62' } } };
const ITEM_JSON = { data: { '3031': { name: 'Infinity Edge', image: { full: '3031.png' }, depth: 2, gold: { total: 3500 } } } };
const SUMMONER_JSON = { data: { SummonerFlash: { key: '4', name: 'Flash', image: { full: 'SummonerFlash.png' } } } };
const RUNES_JSON = [
  {
    id: 8100,
    name: 'Domination',
    icon: 'perk-images/Styles/7200_Domination.png',
    slots: [{ runes: [{ id: 8112, name: 'Electrocute', icon: 'perk-images/Styles/Domination/Electrocute/Electrocute.png' }] }],
  },
];
const CHERRY_AUGMENTS_JSON = [
  { id: 1205, nameTRA: 'ADAPt', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/ADAPt_small.png' },
];

function metadataResponse(url: string): unknown {
  if (url.includes('champion.json')) return CHAMPION_JSON;
  if (url.includes('item.json')) return ITEM_JSON;
  if (url.includes('summoner.json')) return SUMMONER_JSON;
  if (url.includes('runesReforged.json')) return RUNES_JSON;
  if (url.includes('cherry-augments.json')) return CHERRY_AUGMENTS_JSON;
  throw new Error(`unexpected ${url}`);
}

function stubFetch(handler: (url: string) => Promise<Response> | Response) {
  const spy = vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input))));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

afterEach(() => {
  clearStoredIndex();
  vi.unstubAllGlobals();
});

describe('StaticDataContextProvider', () => {
  it('renders children immediately, before any request resolves', () => {
    stubFetch(() => new Promise<Response>(() => undefined) as unknown as Response);

    render(
      <StaticDataContextProvider>
        <Probe />
      </StaticDataContextProvider>,
    );

    // Requirement 5.2: no loading gate. Content is on screen on the first paint.
    expect(screen.getByTestId('ready').textContent).toBe('false');
    expect(screen.getByTestId('name').textContent).toBe('MonkeyKing');
    expect(screen.getByTestId('icon').textContent).toBe('null');
  });

  it('becomes ready and resolves assets after the version and metadata arrive', async () => {
    stubFetch((url) => {
      if (url.includes('/api/static-data')) return ok({ dataDragonVersion: '16.17.1' });
      return ok(metadataResponse(url));
    });

    render(
      <StaticDataContextProvider>
        <Probe />
      </StaticDataContextProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    expect(screen.getByTestId('version').textContent).toBe('16.17.1');
    expect(screen.getByTestId('name').textContent).toBe('Wukong');
    expect(screen.getByTestId('icon').textContent).toContain('/16.17.1/img/champion/MonkeyKing.png');
    // live-game: the numeric-id -> key reverse lookup is built from champion.json's `key`.
    expect(screen.getByTestId('key-for-id').textContent).toBe('MonkeyKing');
  });

  it('stays ready when only the Community_Dragon augments file fails — it must not sink the core index', async () => {
    stubFetch((url) => {
      if (url.includes('/api/static-data')) return ok({ dataDragonVersion: '16.17.1' });
      if (url.includes('cherry-augments.json')) {
        return { ok: false, status: 503, json: () => Promise.resolve({}) } as Response;
      }
      return ok(metadataResponse(url));
    });

    render(
      <StaticDataContextProvider>
        <Probe />
      </StaticDataContextProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    expect(screen.getByTestId('name').textContent).toBe('Wukong');
    expect(screen.getByTestId('key-for-id').textContent).toBe('MonkeyKing');
  });

  it('fetches metadata straight from the CDN, never through the backend', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('/api/static-data')) return ok({ dataDragonVersion: '16.17.1' });
      return ok(metadataResponse(url));
    });

    render(
      <StaticDataContextProvider>
        <Probe />
      </StaticDataContextProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));

    const urls = spy.mock.calls.map((call) => String(call[0]));
    const metadata = urls.filter(
      (u) => u.includes('champion.json') || u.includes('item.json') || u.includes('summoner.json') || u.includes('runesReforged.json'),
    );
    expect(metadata).toHaveLength(4);
    // Requirements 4.5 / 4.6: the CDN directly, not proxied by our API.
    for (const url of metadata) {
      expect(url.startsWith('https://ddragon.leagueoflegends.com/')).toBe(true);
      expect(url).not.toContain('/api/');
    }

    // Requirement 12.5/12.6: augments come from Community_Dragon — a different
    // CDN from Data_Dragon — pinned and never proxied through this backend.
    const cherryAugmentsUrls = urls.filter((u) => u.includes('cherry-augments.json'));
    expect(cherryAugmentsUrls).toHaveLength(1);
    expect(cherryAugmentsUrls[0].startsWith('https://raw.communitydragon.org/16.17/')).toBe(true);
    expect(cherryAugmentsUrls[0]).not.toContain('/api/');
    expect(cherryAugmentsUrls[0]).not.toContain('latest');
  });

  it('keeps the report readable when the version endpoint fails', async () => {
    stubFetch(() => ({ ok: false, status: 500, json: () => Promise.resolve({}) }) as Response);

    render(
      <StaticDataContextProvider>
        <Probe />
      </StaticDataContextProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('name').textContent).toBe('MonkeyKing'));
    expect(screen.getByTestId('ready').textContent).toBe('false');
    expect(screen.getByTestId('icon').textContent).toBe('null');
  });

  it('keeps the report readable when the CDN metadata fetch fails', async () => {
    stubFetch((url) => {
      if (url.includes('/api/static-data')) return ok({ dataDragonVersion: '16.17.1' });
      return { ok: false, status: 503, json: () => Promise.resolve({}) } as Response;
    });

    render(
      <StaticDataContextProvider>
        <Probe />
      </StaticDataContextProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('name').textContent).toBe('MonkeyKing'));
    expect(screen.getByTestId('ready').textContent).toBe('false');
  });

  it('serves a second mount from the persisted index without re-fetching metadata', async () => {
    const spy = stubFetch((url) => {
      if (url.includes('/api/static-data')) return ok({ dataDragonVersion: '16.17.1' });
      return ok(metadataResponse(url));
    });

    const first = render(
      <StaticDataContextProvider>
        <Probe />
      </StaticDataContextProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    first.unmount();

    spy.mockClear();
    render(
      <StaticDataContextProvider>
        <Probe />
      </StaticDataContextProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));

    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('/api/static-data'))).toBe(true);
    // Requirement 4.4: within the TTL the metadata is not fetched again.
    expect(
      urls.filter(
        (u) =>
          u.includes('champion.json') ||
          u.includes('item.json') ||
          u.includes('summoner.json') ||
          u.includes('runesReforged.json') ||
          u.includes('cherry-augments.json'),
      ),
    ).toHaveLength(0);
  });

  it('degrades to placeholders when used outside a provider rather than throwing', () => {
    expect(() => render(<Probe />)).not.toThrow();
    expect(screen.getByTestId('ready').textContent).toBe('false');
    expect(screen.getByTestId('icon').textContent).toBe('null');
  });
});
