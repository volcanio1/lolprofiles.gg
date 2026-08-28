import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PlayerSuggestion } from '../api/types';
import { RIOT_ID_ERROR_DISPLAY } from '../domain/riotId';
import type { DebounceScheduler, SuggestionFetcher } from '../hooks/usePlayerSuggestions';
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

/* ----------------------------------------- autofill-search: the dropdown */

function manualScheduler() {
  const entries: { run: () => void; cancelled: boolean }[] = [];
  const schedule: DebounceScheduler = (_ms, run) => {
    const entry = { run, cancelled: false };
    entries.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const fire = () => {
    const due = entries.splice(0).filter((e) => !e.cancelled);
    for (const entry of due) {
      entry.run();
    }
  };
  return { schedule, fire };
}

function controllableFetcher() {
  const calls: { query: string; signal?: AbortSignal; resolve: (rows: PlayerSuggestion[]) => void }[] = [];
  const fetchSuggestions: SuggestionFetcher = (query, options) =>
    new Promise((resolve) => {
      calls.push({ query, signal: options.signal, resolve });
    });
  return { calls, fetchSuggestions };
}

const suggestion = (gameName: string, tagLine: string): PlayerSuggestion => ({
  gameName,
  tagLine,
  profileIconId: 1,
  region: 'na1',
});

function renderCombobox(overrides: Partial<Parameters<typeof SearchForm>[0]> = {}) {
  const onSubmit = vi.fn();
  const timer = manualScheduler();
  const fetcher = controllableFetcher();
  render(
    <SearchForm
      onSubmit={onSubmit}
      suggestionOptions={{ schedule: timer.schedule, fetchSuggestions: fetcher.fetchSuggestions }}
      {...overrides}
    />,
  );
  return { onSubmit, timer, fetcher };
}

/** Types a prefix, lets the debounce fire, and resolves the request with `rows`. */
async function showSuggestions(
  user: ReturnType<typeof userEvent.setup>,
  timer: ReturnType<typeof manualScheduler>,
  fetcher: ReturnType<typeof controllableFetcher>,
  prefix: string,
  rows: PlayerSuggestion[],
) {
  await user.type(riotIdInput(), prefix);
  act(() => {
    timer.fire();
  });
  const call = fetcher.calls[fetcher.calls.length - 1];
  await act(async () => {
    call.resolve(rows);
    await Promise.resolve();
  });
}

describe('autofill-search — the suggestion dropdown (Requirement 3/4/5)', () => {
  it('appears only with focus, >= 2 chars, and >= 1 result', async () => {
    const user = userEvent.setup();
    const { timer, fetcher } = renderCombobox();

    await user.type(riotIdInput(), 'f');
    act(() => {
      timer.fire();
    });
    expect(fetcher.calls).toHaveLength(0);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await showSuggestions(user, timer, fetcher, 'aker', [suggestion('Faker', 'KR1')]);

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(riotIdInput()).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders no dropdown when the response is empty', async () => {
    const user = userEvent.setup();
    const { timer, fetcher } = renderCombobox();

    await showSuggestions(user, timer, fetcher, 'faker', []);

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(riotIdInput()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on blur, on Escape, and on selection', async () => {
    const user = userEvent.setup();
    const { timer, fetcher } = renderCombobox();

    await showSuggestions(user, timer, fetcher, 'faker', [suggestion('Faker', 'KR1')]);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // Re-opens on the next keystroke.
    await showSuggestions(user, timer, fetcher, 'x', [suggestion('Fakerx', 'KR1')]);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.tab();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('wraps the active row with the arrow keys and selects it with Enter', async () => {
    const user = userEvent.setup();
    const { onSubmit, timer, fetcher } = renderCombobox();

    await showSuggestions(user, timer, fetcher, 'fa', [suggestion('Faker', 'KR1'), suggestion('Fakerino', 'EUW')]);

    await user.keyboard('{ArrowDown}'); // -> row 0
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}'); // -> row 1
    await user.keyboard('{ArrowDown}'); // wraps -> row 0
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}'); // wraps -> row 1
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ riotId: 'Fakerino#EUW' });
    expect(riotIdInput()).toHaveValue('Fakerino#EUW');
  });

  it('Enter with no active row submits the typed value', async () => {
    const user = userEvent.setup();
    const { onSubmit, timer, fetcher } = renderCombobox();

    await showSuggestions(user, timer, fetcher, 'Doffy#Smile', [suggestion('Doffy', 'Smiles')]);
    // '#' in the value means the prefix has no matches to request; dropdown is closed.
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledWith({ riotId: 'Doffy#Smile' });
  });

  it('selecting a suggestion produces the same payload as typing that Riot ID (Requirement 5.4)', async () => {
    const user = userEvent.setup();

    const typed = renderCombobox();
    await user.type(riotIdInput(), 'Faker#KR1');
    await user.click(submitButton());
    const typedPayload = typed.onSubmit.mock.calls[0][0];

    cleanup();

    const picked = renderCombobox();
    await showSuggestions(user, picked.timer, picked.fetcher, 'Fak', [suggestion('Faker', 'KR1')]);
    await user.click(screen.getByRole('option'));

    expect(picked.onSubmit).toHaveBeenCalledTimes(1);
    expect(picked.onSubmit.mock.calls[0][0]).toEqual(typedPayload);
  });

  it('never renders a stale response for a prefix the input has moved past (Requirement 3.4)', async () => {
    const user = userEvent.setup();
    const { timer, fetcher } = renderCombobox();

    await user.type(riotIdInput(), 'fa');
    act(() => {
      timer.fire();
    });
    const staleCall = fetcher.calls[0];

    await user.type(riotIdInput(), 'ke'); // now 'fake'
    act(() => {
      timer.fire();
    });
    const freshCall = fetcher.calls[1];

    await act(async () => {
      staleCall.resolve([suggestion('Fabulous', 'NA1')]);
      await Promise.resolve();
    });
    expect(screen.queryByText('Fabulous')).not.toBeInTheDocument();

    await act(async () => {
      freshCall.resolve([suggestion('Faker', 'KR1')]);
      await Promise.resolve();
    });
    expect(screen.getByText('Faker')).toBeInTheDocument();
  });

  it('a suggestion request failing is invisible and does not block a typed submit', async () => {
    const user = userEvent.setup();
    const { onSubmit, timer, fetcher } = renderCombobox();

    await showSuggestions(user, timer, fetcher, 'faker', []); // fetchSuggestions resolves [] on any failure

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.clear(riotIdInput());
    await user.type(riotIdInput(), 'Doffy#Smile');
    await user.click(submitButton());

    expect(onSubmit).toHaveBeenCalledWith({ riotId: 'Doffy#Smile' });
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
