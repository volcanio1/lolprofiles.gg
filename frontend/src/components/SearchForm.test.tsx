import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RIOT_ID_ERROR_DISPLAY } from '../domain/riotId';
import { SearchForm } from './SearchForm';

/**
 * Tasks 16.1, 16.2. Pure component tests: nothing here reaches the network.
 *
 * lookup-pipeline-fixes Requirement 2.1/2.2: no region or platform selector
 * exists anymore, so this file no longer covers them — see
 * `ProfileReportView.test.tsx` for the `resolvedPlatform` display assertion
 * instead.
 */

function renderForm(overrides: Partial<Parameters<typeof SearchForm>[0]> = {}) {
  const onSubmit = vi.fn();
  render(<SearchForm onSubmit={onSubmit} {...overrides} />);
  return { onSubmit };
}

const riotIdInput = () => screen.getByLabelText('Riot ID');
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

describe('lookup-pipeline-fixes Requirement 2.1/2.2 — no region or platform selector', () => {
  it('does not render a region selector', () => {
    renderForm();
    expect(screen.queryByLabelText('Region')).not.toBeInTheDocument();
  });

  it('does not render a platform selector', () => {
    renderForm();
    expect(screen.queryByLabelText('Platform')).not.toBeInTheDocument();
  });
});

describe('Requirement 1.2 — a well-formed value initiates a lookup', () => {
  it('submits the trimmed Riot ID alone', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();

    await user.type(riotIdInput(), '  Doffy#Smile  ');
    await user.click(submitButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ riotId: 'Doffy#Smile' });
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

describe('prefill and busy state', () => {
  it('prefills the Riot ID from the supplied value', () => {
    render(<SearchForm onSubmit={vi.fn()} initialRiotId="Doffy#Smile" />);

    expect(riotIdInput()).toHaveValue('Doffy#Smile');
  });

  it('disables submission while a lookup is in flight', () => {
    render(<SearchForm onSubmit={vi.fn()} busy />);

    expect(screen.getByRole('button', { name: /searching/i })).toBeDisabled();
  });
});
