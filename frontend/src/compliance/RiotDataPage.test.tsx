import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RIOT_ATTRIBUTION_TEXT, RiotDataPage } from './RiotDataPage';
import { advertisingPermitted, approvedAdvertisingAgreement } from './advertisingPolicy';

/**
 * Task 16.7 — Requirements 12.1, 12.2 and 12.3.
 *
 * The attribution text is asserted against the literal string from Requirement
 * 12.1, transcribed here rather than imported, so a reworded constant fails the
 * test instead of quietly redefining what compliance means.
 */

/** Requirement 12.1, verbatim from the requirements document. */
const REQUIRED_ATTRIBUTION =
  "lolprofiles.gg isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing League of Legends. League of Legends and Riot Games are trademarks or registered trademarks of Riot Games, Inc.";

/** Patterns that would indicate an advertising or sponsored-content slot (12.2). */
const AD_PATTERNS = [/\badvert/i, /\bsponsor/i, /\bpromot/i, /\bpaid partner/i];

describe('Requirement 12.1 — attribution on every page rendering Riot data', () => {
  it('displays the required statement verbatim', () => {
    render(
      <RiotDataPage title="Profile report">
        <p>Riot data goes here</p>
      </RiotDataPage>,
    );

    expect(screen.getByTestId('riot-attribution')).toHaveTextContent(REQUIRED_ATTRIBUTION);
  });

  it('exports the statement exactly as the requirement words it', () => {
    // Guards against a well-meaning rewrite of the constant.
    expect(RIOT_ATTRIBUTION_TEXT).toBe(REQUIRED_ATTRIBUTION);
  });

  it('displays it regardless of what the page content is', () => {
    // Requirement 12.1 is scoped to the page, not to a successful report, so an
    // error or loading state must still carry it.
    for (const content of [<p key="a">Loading…</p>, <p key="b">Player not found</p>, <p key="c" />]) {
      const { unmount } = render(<RiotDataPage title="Profile report">{content}</RiotDataPage>);
      expect(screen.getByTestId('riot-attribution')).toHaveTextContent(REQUIRED_ATTRIBUTION);
      unmount();
    }
  });

  it('names Riot Games and League of Legends trademarks, and disclaims endorsement', () => {
    render(
      <RiotDataPage title="Profile report">
        <p>data</p>
      </RiotDataPage>,
    );

    const text = screen.getByTestId('riot-attribution').textContent ?? '';
    expect(text).toContain("isn't endorsed by Riot Games");
    expect(text).toContain('trademarks or registered trademarks of Riot Games, Inc.');
  });
});

describe('Requirement 12.2 — no advertising on pages rendering Riot data', () => {
  it('renders no advertising slot by default', () => {
    render(
      <RiotDataPage title="Profile report">
        <p>Riot data goes here</p>
      </RiotDataPage>,
    );

    expect(screen.queryByTestId('advertising-slot')).not.toBeInTheDocument();
  });

  it('contains no advertising, sponsorship or promotion language anywhere on the page', () => {
    const { container } = render(
      <RiotDataPage title="Profile report">
        <p>Riot data goes here</p>
      </RiotDataPage>,
    );

    const markup = container.innerHTML;
    for (const pattern of AD_PATTERNS) {
      expect(markup, `matched ${String(pattern)}`).not.toMatch(pattern);
    }
  });

  it('ships with no approved agreement, so the prohibition is the default everywhere', () => {
    // The single override point is `undefined` in the committed source.
    expect(approvedAdvertisingAgreement).toBeUndefined();
    expect(advertisingPermitted(approvedAdvertisingAgreement)).toBe(false);
  });
});

describe('Requirement 12.3 — approved-agreement exception path', () => {
  it('permits an advertising slot when an approved agreement authorizes a scope', () => {
    render(
      <RiotDataPage
        title="Profile report"
        advertisingAgreement={{ agreementReference: 'RIOT-2026-0042', authorizedScope: 'display banners' }}
      >
        <p>Riot data goes here</p>
      </RiotDataPage>,
    );

    const slot = screen.getByTestId('advertising-slot');
    expect(slot).toBeInTheDocument();
    // The authorizing agreement is identified in the rendered output, so the
    // exception is auditable rather than anonymous.
    expect(slot).toHaveTextContent('RIOT-2026-0042');
  });

  it('still displays the attribution when advertising is permitted', () => {
    render(
      <RiotDataPage
        title="Profile report"
        advertisingAgreement={{ agreementReference: 'RIOT-2026-0042', authorizedScope: 'display banners' }}
      >
        <p>data</p>
      </RiotDataPage>,
    );

    expect(screen.getByTestId('riot-attribution')).toHaveTextContent(REQUIRED_ATTRIBUTION);
  });

  it('treats an agreement with no authorized scope as authorizing nothing', () => {
    // Requirement 12.3 permits advertising only "limited to the scope authorized",
    // so an empty scope is not a loophole.
    render(
      <RiotDataPage title="Profile report" advertisingAgreement={{ agreementReference: 'X', authorizedScope: '   ' }}>
        <p>data</p>
      </RiotDataPage>,
    );

    expect(screen.queryByTestId('advertising-slot')).not.toBeInTheDocument();
    expect(advertisingPermitted({ agreementReference: 'X', authorizedScope: '' })).toBe(false);
  });
});
