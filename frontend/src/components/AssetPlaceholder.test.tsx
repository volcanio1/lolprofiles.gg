import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssetPlaceholder } from './AssetPlaceholder';

/** Task 2.4 — Requirements 5.1 (layout stability) and 6.4 (text alternative). */

describe('AssetPlaceholder', () => {
  it('reserves exactly the box it was asked for, so a missing image cannot reflow the page', () => {
    render(<AssetPlaceholder size={32} label="Champion icon unavailable" />);

    const placeholder = screen.getByTestId('asset-placeholder');
    expect(placeholder.style.width).toBe('32px');
    expect(placeholder.style.height).toBe('32px');
  });

  it('reserves a square box at any size, not one fixed default', () => {
    const { rerender } = render(<AssetPlaceholder size={24} label="Item unavailable" />);
    expect(screen.getByTestId('asset-placeholder').style.width).toBe('24px');

    rerender(<AssetPlaceholder size={64} label="Item unavailable" />);
    const placeholder = screen.getByTestId('asset-placeholder');
    expect(placeholder.style.width).toBe('64px');
    expect(placeholder.style.height).toBe('64px');
  });

  it('exposes a non-empty text alternative to assistive technology', () => {
    render(<AssetPlaceholder size={32} label="Champion icon unavailable" />);

    const placeholder = screen.getByRole('img', { name: 'Champion icon unavailable' });
    expect(placeholder).toBeInTheDocument();
    expect(placeholder.getAttribute('aria-label')).not.toBe('');
  });

  it('is not hidden from assistive technology, so the absence is detectable non-visually', () => {
    render(<AssetPlaceholder size={32} label="Profile icon unavailable" />);

    const placeholder = screen.getByTestId('asset-placeholder');
    expect(placeholder).not.toHaveAttribute('aria-hidden');
    expect(placeholder).toHaveAttribute('role', 'img');
  });

  it('renders no <img>, so nothing requests a source that could not be constructed', () => {
    const { container } = render(<AssetPlaceholder size={32} label="Item unavailable" />);

    expect(container.querySelector('img')).toBeNull();
  });

  it('keeps its base class while accepting call-site shaping', () => {
    render(<AssetPlaceholder size={48} label="Profile icon unavailable" className="avatar" />);

    const placeholder = screen.getByTestId('asset-placeholder');
    expect(placeholder).toHaveClass('asset-placeholder');
    expect(placeholder).toHaveClass('avatar');
  });
});
