import { render, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { describe, expect, it } from 'vitest';
import { SEO } from './SEO';

function renderSEO(props: Parameters<typeof SEO>[0]) {
  return render(
    <HelmetProvider>
      <SEO {...props} />
    </HelmetProvider>,
  );
}

describe('SEO', () => {
  it('appends the site name to a page-specific title', async () => {
    renderSEO({ title: 'Doffy#Smile' });
    await waitFor(() => expect(document.title).toBe('Doffy#Smile — lolprofiles.gg'));
  });

  it('does not double the site name when the title already ends with it', async () => {
    renderSEO({ title: 'lolprofiles.gg' });
    await waitFor(() => expect(document.title).toBe('lolprofiles.gg'));
  });

  it('sets the meta description', async () => {
    renderSEO({ title: 'Search a player', description: 'Custom description text.' });
    await waitFor(() => {
      const meta = document.querySelector('meta[name="description"]');
      expect(meta?.getAttribute('content')).toBe('Custom description text.');
    });
  });

  it('defaults robots to index,follow, and switches to noindex,nofollow when asked', async () => {
    renderSEO({ title: 'Indexed page' });
    await waitFor(() => {
      expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('index, follow');
    });

    renderSEO({ title: 'Not found', noindex: true });
    await waitFor(() => {
      expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, nofollow');
    });
  });

  it('sets Open Graph and Twitter Card tags', async () => {
    renderSEO({ title: 'A player profile', description: 'Ranked stats and match history.' });
    await waitFor(() => {
      expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(
        'A player profile — lolprofiles.gg',
      );
      expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(
        'Ranked stats and match history.',
      );
      expect(document.querySelector('meta[property="og:image"]')).toBeInTheDocument();
      expect(document.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary');
    });
  });
});
