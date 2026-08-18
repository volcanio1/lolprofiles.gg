import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PLATFORM_LABELS, REGION_LABELS, platformsFor, type RegionalRoutingValue } from '../domain/regions';
import { RIOT_ID_ERROR_DISPLAY } from '../domain/riotId';
import { SearchForm } from './SearchForm';

/**
 * Tasks 16.1, 16.2 and part of 16.7 (region selector content per Requirement 1.7).
 * Pure component tests: nothing here reaches the network.
 */

function renderForm(overrides: Partial<Parameters<typeof SearchForm>[0]> = {}) {
  const onSubmit = vi.fn();
  render(<SearchForm onSubmit={onSubmit} {...overrides} />);
  return { onSubmit };
}

const riotIdInput = () => screen.getByLabelText('Riot ID');
const regionSelect = () => screen.getByLabelText('Region') as HTMLSelectElement;
const platformSelect = () => screen.getByLabelText('Platform') as HTMLSelectElement;
const submitButton = () => screen.getByRole('button', { name: /search/i });

describe('Requirement 1.1 — the Riot ID input', () => {
  it('renders a text input that advertises the expected format', () => {
    renderForm();

    const input = riotIdInput();
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('placeholder', 'gameName#tagLine');
  });
});

describe('Requirement 1.2 — a well-formed value initiates a lookup', () => {
  it('submits the trimmed Riot ID and the selected region', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(riotIdInput(), '  Doffy#Smile  ');
    await user.selectOptions(regionSelect(), 'europe');
    await user.click(submitButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ riotId: 'Doffy#Smile', region: 'europe', platform: undefined });
  });

  it('submits the chosen platform when one is selected', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(riotIdInput(), 'Doffy#Smile');
    await user.selectOptions(regionSelect(), 'europe');
    await user.selectOptions(platformSelect(), 'euw1');
    await user.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith({ riotId: 'Doffy#Smile', region: 'europe', platform: 'euw1' });
  });
});

describe('Requirements 1.3-1.5 / 9.1 — inline validation before dispatch', () => {
  const cases: { name: string; value: string; rule: keyof typeof RIOT_ID_ERROR_DISPLAY }[] = [
    { name: 'no # at all', value: 'Doffy', rule: 'MISSING_HASH' },
    { name: 'more than one #', value: 'Doffy#Smile#X', rule: 'MULTIPLE_HASH' },
    { name: 'empty game name', value: '#Smile', rule: 'EMPTY_PART' },
    { name: 'empty tag line', value: 'Doffy#', rule: 'EMPTY_PART' },
    { name: 'game name too long', value: 'ThisNameIsFarTooLong#EUW', rule: 'GAME_NAME_TOO_LONG' },
    { name: 'tag line too long', value: 'Doffy#TooLong', rule: 'TAG_LINE_TOO_LONG' },
  ];

  for (const { name, value, rule } of cases) {
    it(`rejects ${name} with the rule-specific message and dispatches nothing`, async () => {
      const user = userEvent.setup();
      const { onSubmit } = renderForm();

      await user.type(riotIdInput(), value);
      await user.click(submitButton());

      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(RIOT_ID_ERROR_DISPLAY[rule].message);
    });
  }

  it('rejects an empty submission without dispatching', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.click(submitButton());

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('associates the message with the input for assistive technology', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(riotIdInput(), 'Doffy');
    await user.click(submitButton());

    const input = riotIdInput();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(screen.getByRole('alert').id).toBe(describedBy);
  });

  it('clears the message as soon as the visitor edits the field', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(riotIdInput(), 'Doffy');
    await user.click(submitButton());
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.type(riotIdInput(), '#Smile');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(riotIdInput()).toHaveAttribute('aria-invalid', 'false');
  });

  it('does not validate while typing, only on submit', async () => {
    const user = userEvent.setup();
    renderForm();

    // Mid-typing the value is invalid, but nagging about it would be unhelpful.
    await user.type(riotIdInput(), 'Doff');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Requirement 1.6 / 1.7 — region selector', () => {
  it('defaults to americas', () => {
    renderForm();
    expect(regionSelect()).toHaveValue('americas');
  });

  it('offers exactly the four supported regions, in order', () => {
    renderForm();

    const values = Array.from(regionSelect().options).map((option) => option.value);
    expect(values).toEqual(['americas', 'europe', 'asia', 'sea']);
  });

  it('labels each region readably rather than exposing the routing value', () => {
    renderForm();

    for (const region of ['americas', 'europe', 'asia', 'sea'] as RegionalRoutingValue[]) {
      expect(screen.getByRole('option', { name: REGION_LABELS[region] })).toBeInTheDocument();
    }
  });
});

describe('Requirement 5.3 — platform choices are restricted to the selected region', () => {
  const expected: Record<RegionalRoutingValue, string[]> = {
    americas: ['na1', 'br1', 'la1', 'la2'],
    europe: ['euw1', 'eun1', 'tr1', 'ru'],
    asia: ['kr', 'jp1'],
    sea: ['oc1'],
  };

  for (const region of Object.keys(expected) as RegionalRoutingValue[]) {
    it(`offers exactly ${region}'s platforms when ${region} is selected`, async () => {
      const user = userEvent.setup();
      renderForm();

      await user.selectOptions(regionSelect(), region);

      const values = Array.from(platformSelect().options)
        .map((option) => option.value)
        .filter((value) => value.length > 0);
      expect(values).toEqual(expected[region]);
      // And nothing from another region leaked in.
      expect(values).toEqual([...platformsFor(region)]);
    });
  }

  it('offers an explicit "any platform" default, so no platform is pre-chosen for the visitor', () => {
    renderForm();

    expect(platformSelect()).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Any platform in this region' })).toBeInTheDocument();
  });

  it('labels platforms with names a player recognizes', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(regionSelect(), 'europe');

    expect(screen.getByRole('option', { name: PLATFORM_LABELS.euw1 })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: PLATFORM_LABELS.eun1 })).toBeInTheDocument();
  });

  it('resets a platform that does not belong to the newly selected region', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.selectOptions(regionSelect(), 'europe');
    await user.selectOptions(platformSelect(), 'euw1');
    expect(platformSelect()).toHaveValue('euw1');

    // Switching region must not leave a stale, out-of-region platform selected.
    await user.selectOptions(regionSelect(), 'asia');
    expect(platformSelect()).toHaveValue('');

    await user.type(riotIdInput(), 'Doffy#Smile');
    await user.click(submitButton());
    expect(onSubmit).toHaveBeenCalledWith({ riotId: 'Doffy#Smile', region: 'asia', platform: undefined });
  });

  it('keeps a platform that is still valid for the newly selected region', async () => {
    // No such platform exists across regions (they are disjoint), so switching
    // always resets — asserted so the behavior is pinned rather than incidental.
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(regionSelect(), 'americas');
    await user.selectOptions(platformSelect(), 'na1');
    await user.selectOptions(regionSelect(), 'americas');

    expect(platformSelect()).toHaveValue('na1');
  });
});

describe('prefill and busy state', () => {
  it('prefills from the supplied values, so correcting a region is one interaction', () => {
    render(
      <SearchForm onSubmit={vi.fn()} initialRiotId="Doffy#Smile" initialRegion="europe" initialPlatform="euw1" />,
    );

    expect(riotIdInput()).toHaveValue('Doffy#Smile');
    expect(regionSelect()).toHaveValue('europe');
    expect(platformSelect()).toHaveValue('euw1');
  });

  it('disables submission while a lookup is in flight', () => {
    render(<SearchForm onSubmit={vi.fn()} busy />);

    expect(screen.getByRole('button', { name: /searching/i })).toBeDisabled();
  });
});
