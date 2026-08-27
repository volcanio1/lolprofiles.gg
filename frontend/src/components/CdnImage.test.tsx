import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CdnImage } from './CdnImage';

/**
 * `match-detail-tabs` task 4.1 — Requirements 7.11 (never a throw, never an
 * unresolvable image element), 9.3 (renders no image whose source could not be
 * constructed), 8.1 (non-empty text alternative for every rendered asset image).
 */

describe('CdnImage', () => {
  it('renders an <img> at the requested size with the given alt text when the url resolves', () => {
    render(<CdnImage url="https://ddragon.leagueoflegends.com/cdn/spell/Flash.png" alt="Flash" fallbackLabel="Flash unavailable" size={24} />);

    const img = screen.getByRole('img', { name: 'Flash' }) as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toBe('https://ddragon.leagueoflegends.com/cdn/spell/Flash.png');
    expect(img.width).toBe(24);
    expect(img.height).toBe(24);
  });

  it('renders an AssetPlaceholder at the same size, never an <img>, when url is null', () => {
    const { container } = render(<CdnImage url={null} alt="Flash" fallbackLabel="Flash unavailable" size={24} />);

    expect(container.querySelector('img')).toBeNull();
    const placeholder = screen.getByTestId('asset-placeholder');
    expect(placeholder.style.width).toBe('24px');
    expect(placeholder.style.height).toBe('24px');
    expect(screen.getByRole('img', { name: 'Flash unavailable' })).toBe(placeholder);
  });

  it('swaps to the placeholder when the rendered <img> fails to load, without ever re-requesting the same URL', () => {
    const { container } = render(<CdnImage url="https://example.invalid/does-not-exist.png" alt="Flash" fallbackLabel="Flash unavailable" size={24} />);

    const img = screen.getByRole('img', { name: 'Flash' });
    fireEvent.error(img);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('asset-placeholder')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Flash unavailable' })).toBeInTheDocument();
  });

  it('passes className through to whichever element renders, image or placeholder', () => {
    const { rerender } = render(
      <CdnImage url="https://ddragon.leagueoflegends.com/cdn/spell/Flash.png" alt="Flash" fallbackLabel="Flash unavailable" size={24} className="spell-icon" />,
    );
    expect(screen.getByRole('img', { name: 'Flash' })).toHaveClass('spell-icon');

    rerender(<CdnImage url={null} alt="Flash" fallbackLabel="Flash unavailable" size={24} className="spell-icon" />);
    expect(screen.getByTestId('asset-placeholder')).toHaveClass('spell-icon');
  });
});
