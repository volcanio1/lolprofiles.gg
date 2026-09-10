import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CookieNotice } from './CookieNotice';
import { ANALYTICS_CONSENT_KEY } from '../analytics';

/**
 * The banner is a consent gate: it must show on a first visit, must not show
 * once a choice is stored, and must push that choice to gtag both when the
 * visitor clicks and when a stored choice is restored on load.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('CookieNotice consent gate', () => {
  it('shows on a first visit and records an acceptance', async () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const user = userEvent.setup();

    render(<CookieNotice />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept analytics' }));

    expect(window.localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('granted');
    expect(gtag).toHaveBeenCalledWith(
      'consent',
      'update',
      expect.objectContaining({ analytics_storage: 'granted' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('records a decline without granting analytics storage', async () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    const user = userEvent.setup();

    render(<CookieNotice />);
    await user.click(screen.getByRole('button', { name: 'Decline' }));

    expect(window.localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('denied');
    expect(gtag).toHaveBeenCalledWith(
      'consent',
      'update',
      expect.objectContaining({ analytics_storage: 'denied' }),
    );
  });

  it('stays hidden but re-applies a stored decision on load', () => {
    const gtag = vi.fn();
    vi.stubGlobal('gtag', gtag);
    window.localStorage.setItem(ANALYTICS_CONSENT_KEY, 'granted');

    render(<CookieNotice />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(gtag).toHaveBeenCalledWith(
      'consent',
      'update',
      expect.objectContaining({ analytics_storage: 'granted' }),
    );
  });
});
