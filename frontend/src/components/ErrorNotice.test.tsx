import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorPayload, ErrorCode } from '../api/types';
import { ErrorNotice } from './ErrorNotice';

/** Task 16.5 — the distinct error states of Requirement 9. */

function renderNotice(error: ApiErrorPayload, overrides: Partial<Parameters<typeof ErrorNotice>[0]> = {}) {
  const onRetry = vi.fn();
  render(
    <ErrorNotice
      error={error}
      canRetry={overrides.canRetry ?? error.retriable}
      retriesRemaining={overrides.retriesRemaining ?? 3}
      cooldownSecondsRemaining={overrides.cooldownSecondsRemaining ?? 0}
      onRetry={overrides.onRetry ?? onRetry}
    />,
  );
  return { onRetry: overrides.onRetry ?? onRetry };
}

const payload = (code: ErrorCode, message: string, retriable: boolean, extra: Partial<ApiErrorPayload> = {}): ApiErrorPayload => ({
  code,
  message,
  retriable,
  ...extra,
});

describe('distinct states per Requirement 9', () => {
  const states: { code: ErrorCode; message: string; retriable: boolean }[] = [
    { code: 'VALIDATION_FAILED', message: 'Enter a Riot ID in the format gameName#tagLine.', retriable: false },
    { code: 'PLAYER_NOT_FOUND', message: 'No player was found for the Riot ID Doffy#Smile.', retriable: false },
    { code: 'PLAYER_NOT_ON_PLATFORM', message: 'Doffy#Smile has no profile on NA1 (americas).', retriable: false },
    { code: 'RIOT_UNAVAILABLE', message: "Riot's services are temporarily unavailable.", retriable: true },
    { code: 'TIMEOUT', message: 'The lookup timed out before Riot responded.', retriable: false },
    { code: 'AUTH_FAILURE', message: 'This service is temporarily unavailable.', retriable: false },
    { code: 'RATE_LIMITED', message: 'This lookup was rate-limited.', retriable: true },
    { code: 'NETWORK_ERROR', message: 'A connection error occurred.', retriable: true },
    { code: 'MATCH_HISTORY_UNAVAILABLE', message: 'Match history could not be retrieved.', retriable: true },
    { code: 'UNSUPPORTED_REGION', message: 'That region is not supported.', retriable: false },
  ];

  for (const state of states) {
    it(`renders the backend message for ${state.code} and announces it`, () => {
      renderNotice(payload(state.code, state.message, state.retriable));

      expect(screen.getByTestId('error-message')).toHaveTextContent(state.message);
      // A failed lookup answers something the visitor asked for, so it is assertive.
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument();
    });
  }

  it('gives each state a heading, so they are visually distinguishable', () => {
    const headings = new Set<string>();
    for (const state of states) {
      const { unmount } = render(
        <ErrorNotice
          error={payload(state.code, state.message, state.retriable)}
          canRetry={false}
          retriesRemaining={3}
          cooldownSecondsRemaining={0}
          onRetry={vi.fn()}
        />,
      );
      headings.add(screen.getByRole('heading', { level: 2 }).textContent ?? '');
      unmount();
    }
    // AUTH_FAILURE deliberately shares RIOT_UNAVAILABLE's heading (Requirement 9.5),
    // so the count is one fewer than the number of states.
    expect(headings.size).toBe(states.length - 1);
  });

  it('gives the wrong-region state its own heading and a pointer to the fix (Requirement 9.10)', () => {
    renderNotice(
      payload(
        'PLAYER_NOT_ON_PLATFORM',
        'Doffy#Smile exists, but has no League of Legends profile on NA1 (americas). Select the region where this player plays and search again.',
        false,
        { gameName: 'Doffy', tagLine: 'Smile', region: 'americas', platform: 'na1', field: 'region' },
      ),
    );

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Not on this region');
    expect(screen.getByTestId('error-message')).toHaveTextContent('NA1');
    expect(screen.getByTestId('wrong-region-hint')).toHaveTextContent(/region selector/i);
    // It must not read as an outage — that was the bug this state exists to fix.
    expect(screen.getByTestId('error-message')).not.toHaveTextContent(/unavailable/i);
    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });

  it('does not show the region hint for other error states', () => {
    renderNotice(payload('PLAYER_NOT_FOUND', 'No player was found.', false));
    expect(screen.queryByTestId('wrong-region-hint')).not.toBeInTheDocument();
  });

  it('distinguishes "not on this region" from "no such player" by heading', () => {
    const { unmount } = render(
      <ErrorNotice
        error={payload('PLAYER_NOT_ON_PLATFORM', 'exists elsewhere', false)}
        canRetry={false}
        retriesRemaining={3}
        cooldownSecondsRemaining={0}
        onRetry={vi.fn()}
      />,
    );
    const notOnPlatform = screen.getByRole('heading', { level: 2 }).textContent;
    unmount();

    renderNotice(payload('PLAYER_NOT_FOUND', 'no such player', false));
    expect(screen.getByRole('heading', { level: 2 }).textContent).not.toBe(notOnPlatform);
  });

  it('presents Requirement 9.2 with the submitted Riot ID that the backend echoed', () => {
    renderNotice(
      payload('PLAYER_NOT_FOUND', 'No player was found for the Riot ID Doffy#Smile.', false, {
        gameName: 'Doffy',
        tagLine: 'Smile',
      }),
    );

    expect(screen.getByTestId('error-message')).toHaveTextContent('Doffy#Smile');
  });
});

describe('Requirement 9.5 — the auth failure stays generic', () => {
  it('uses the same heading as an ordinary outage and leaks no credential detail', () => {
    const { container } = render(
      <ErrorNotice
        error={payload('AUTH_FAILURE', 'This service is temporarily unavailable. Please try again later.', false)}
        canRetry={false}
        retriesRemaining={3}
        cooldownSecondsRemaining={0}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Service temporarily unavailable');
    const markup = container.innerHTML.toLowerCase();
    for (const forbidden of ['key', 'token', 'credential', '401', '403', 'unauthorized', 'forbidden']) {
      expect(markup, `leaked "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe('Requirement 9.3 — bounded retry', () => {
  it('offers a retry for a retriable failure and reports the remaining budget', async () => {
    const user = userEvent.setup();
    const { onRetry } = renderNotice(payload('RIOT_UNAVAILABLE', 'down', true), { retriesRemaining: 3 });

    expect(screen.getByTestId('retries-remaining')).toHaveTextContent('3 retries remaining');
    await user.click(screen.getByTestId('retry-button'));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no retry for a non-retriable failure', () => {
    renderNotice(payload('PLAYER_NOT_FOUND', 'nope', false));

    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });

  it('replaces the action with an explanation once the budget is exhausted', () => {
    renderNotice(payload('RIOT_UNAVAILABLE', 'down', true), { retriesRemaining: 0, canRetry: false });

    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('retries-exhausted')).toHaveTextContent(/all available retries/i);
  });

  it('uses the singular when one retry is left', () => {
    renderNotice(payload('RIOT_UNAVAILABLE', 'down', true), { retriesRemaining: 1 });

    expect(screen.getByTestId('retries-remaining')).toHaveTextContent('1 retry remaining');
  });
});

describe('Requirement 9.8 — rate-limit cooldown', () => {
  it('keeps the retry action present but disabled during the cooldown', () => {
    renderNotice(payload('RATE_LIMITED', 'rate-limited', true, { retryAfterSeconds: 5 }), {
      canRetry: false,
      cooldownSecondsRemaining: 5,
    });

    const button = screen.getByTestId('retry-button');
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it('tells the visitor how long is left', () => {
    renderNotice(payload('RATE_LIMITED', 'rate-limited', true), { canRetry: false, cooldownSecondsRemaining: 5 });

    expect(screen.getByTestId('cooldown-notice')).toHaveTextContent('5 seconds');
  });

  it('uses the singular at one second remaining', () => {
    renderNotice(payload('RATE_LIMITED', 'rate-limited', true), { canRetry: false, cooldownSecondsRemaining: 1 });

    expect(screen.getByTestId('cooldown-notice')).toHaveTextContent('1 second.');
  });

  it('enables the action and drops the countdown once the cooldown has passed', () => {
    renderNotice(payload('RATE_LIMITED', 'rate-limited', true), { canRetry: true, cooldownSecondsRemaining: 0 });

    expect(screen.getByTestId('retry-button')).toBeEnabled();
    expect(screen.queryByTestId('cooldown-notice')).not.toBeInTheDocument();
  });

  it('does not fire the retry callback while disabled', async () => {
    const user = userEvent.setup();
    const { onRetry } = renderNotice(payload('RATE_LIMITED', 'rate-limited', true), {
      canRetry: false,
      cooldownSecondsRemaining: 5,
    });

    await user.click(screen.getByTestId('retry-button'));

    expect(onRetry).not.toHaveBeenCalled();
  });
});
