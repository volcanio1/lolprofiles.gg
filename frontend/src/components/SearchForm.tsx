/**
 * Riot ID search form.
 *
 * Implements:
 *  - 1.1: a text input accepting `gameName#tagLine`.
 *  - 1.2: a well-formed value initiates a Lookup_Session.
 *  - 1.3-1.5 / 9.1: a malformed value is rejected on submit and a message naming
 *    the specific rule that failed is displayed, without dispatching anything.
 *  - lookup-pipeline-fixes Requirement 2.1/2.2: no region or platform selector —
 *    the backend discovers the platform from the Riot ID alone.
 *  - autofill-search Requirements 3-5: an as-you-type suggestion dropdown driven
 *    by `usePlayerSuggestions`, wired as an ARIA combobox, where selecting a row
 *    fills a known-good Riot ID and submits it.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. VALIDATION RUNS ON SUBMIT, NOT ON EVERY KEYSTROKE. Requirements 1.3-1.5 are
 *    phrased as reactions to a submission, and validating while typing would tell a
 *    visitor their Riot ID is malformed before they have finished typing the `#` —
 *    technically true and actively unhelpful. Once an error is showing, it clears as
 *    soon as the field is edited, so the message never contradicts what is on screen.
 *
 * 2. THE ERROR IS WIRED UP FOR ASSISTIVE TECHNOLOGY, not merely displayed:
 *    `aria-invalid` marks the field, `aria-describedby` ties the message to it, and
 *    `role="alert"` announces it. A validation message a screen-reader user cannot
 *    perceive does not satisfy "display a message" in any useful sense.
 *
 * 3. lookup-pipeline-fixes REMOVED THE REGION AND PLATFORM SELECTORS ENTIRELY,
 *    rather than hiding them behind a toggle. Requirement 2.1 says the request
 *    contains only a Riot_ID and Requirement 2.2 says the search interface must
 *    not display either selector.
 *
 * 4. autofill-search — THE DROPDOWN NEVER CHANGES WHAT SUBMIT MEANS. `activeIndex`
 *    is `-1` (no active row) until the visitor arrows or hovers into the list; with
 *    no active row, Enter falls through to the form's normal submit path
 *    (Requirement 4.3). Selecting a row builds the value from a known-good record
 *    and still runs it through `validateRiotId` before dispatching (Requirement
 *    5.3), so the suggestion path and the typed path share one validation.
 *
 * 5. autofill-search — ROWS USE `onMouseDown` WITH `preventDefault`, NOT `onClick`.
 *    A click on a row would blur the input first, closing the dropdown before the
 *    click resolves. `mousedown` fires before blur and `preventDefault` keeps focus
 *    on the input through the selection (Requirement 4.5 / 3.6).
 */

import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { RIOT_ID_ERROR_DISPLAY, validateRiotId } from '../domain/riotId';
import { namePrefixOf } from '../domain/suggestions';
import { usePlayerSuggestions, type UsePlayerSuggestionsOptions } from '../hooks/usePlayerSuggestions';
import type { PlayerSuggestion } from '../api/types';
import { ProfileIcon } from './ProfileIcon';

export interface SearchSubmission {
  /** The raw, trimmed `gameName#tagLine` value; the backend re-validates it. */
  riotId: string;
}

export interface SearchFormProps {
  onSubmit: (submission: SearchSubmission) => void;
  /**
   * autofill-search Requirement 9.8: called instead of `onSubmit` when the value
   * came from picking a dropdown suggestion, so the caller can try the cached
   * report first. Defaults to `onSubmit` when not supplied.
   */
  onSelectSuggestion?: (submission: SearchSubmission) => void;
  /** Prefills when returning to the form from a report. */
  initialRiotId?: string;
  /** Disables submission while a lookup is in flight. */
  busy?: boolean;
  /** Injected in tests; production uses the real debounced fetch. */
  suggestionOptions?: UsePlayerSuggestionsOptions;
}

export function SearchForm({
  onSubmit,
  onSelectSuggestion,
  initialRiotId = '',
  busy = false,
  suggestionOptions,
}: SearchFormProps) {
  const [riotId, setRiotId] = useState(initialRiotId);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const riotIdInputId = useId();
  const riotIdErrorId = useId();
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${String(index)}`;

  const { suggestions, clear } = usePlayerSuggestions(namePrefixOf(riotId), suggestionOptions);

  const open = focused && !dismissed && suggestions.length > 0;
  const active = open && activeIndex >= 0 && activeIndex < suggestions.length ? activeIndex : -1;

  function dispatch(value: string, viaSuggestion: boolean) {
    const validation = validateRiotId(value);
    if (!validation.ok) {
      setErrorMessage(RIOT_ID_ERROR_DISPLAY[validation.errorCode].message);
      return;
    }
    setErrorMessage(undefined);
    const submission: SearchSubmission = {
      riotId: `${validation.riotId.gameName}#${validation.riotId.tagLine}`,
    };
    if (viaSuggestion && onSelectSuggestion !== undefined) {
      onSelectSuggestion(submission);
    } else {
      onSubmit(submission);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Requirements 1.3-1.5 / 9.1: reject before dispatching anything.
    dispatch(riotId, false);
  }

  function select(suggestion: PlayerSuggestion) {
    const value = `${suggestion.gameName}#${suggestion.tagLine}`;
    setRiotId(value);
    clear();
    setDismissed(true);
    setActiveIndex(-1);
    // Decision 4: still runs through the shared validator (Requirement 5.3/5.4).
    dispatch(value, true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
      }
      setDismissed(true);
      setActiveIndex(-1);
      return;
    }
    if (!open) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % suggestions.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
      return;
    }
    if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      select(suggestions[active]);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Player search" noValidate className="search-form">
      <div className="field">
        <label htmlFor={riotIdInputId} className="field-label">
          Riot ID
        </label>
        <div className="search-combobox">
          <input
            id={riotIdInputId}
            name="riotId"
            type="text"
            value={riotId}
            placeholder="gameName#tagLine"
            autoComplete="off"
            className="field-input"
            // Decision 2.
            aria-invalid={errorMessage !== undefined}
            aria-describedby={errorMessage !== undefined ? riotIdErrorId : undefined}
            // autofill-search Requirement 4.1 / 4.7.
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              setFocused(true);
            }}
            onBlur={() => {
              setFocused(false);
            }}
            onChange={(event) => {
              setRiotId(event.target.value);
              // Requirement 3.6 / 4.7: a keystroke re-opens a dismissed dropdown.
              setDismissed(false);
              setActiveIndex(-1);
              // Decision 1: an edit clears a message that may no longer apply.
              if (errorMessage !== undefined) {
                setErrorMessage(undefined);
              }
            }}
          />
          {open ? (
            <ul id={listboxId} role="listbox" className="suggestion-list">
              {suggestions.map((suggestion, index) => (
                <li
                  key={`${suggestion.gameName}#${suggestion.tagLine}`}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? 'suggestion suggestion--active' : 'suggestion'}
                  onMouseEnter={() => {
                    setActiveIndex(index);
                  }}
                  onMouseDown={(event) => {
                    // Decision 5.
                    event.preventDefault();
                    select(suggestion);
                  }}
                >
                  <ProfileIcon profileIconId={suggestion.profileIconId} size={24} className="suggestion-icon" />
                  <span className="suggestion-name">{suggestion.gameName}</span>
                  <span className="suggestion-tag">#{suggestion.tagLine}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {errorMessage !== undefined ? (
          <p id={riotIdErrorId} role="alert" className="field-error">
            {errorMessage}
          </p>
        ) : null}
      </div>

      <button type="submit" disabled={busy} className="btn btn-primary">
        {busy ? 'Searching…' : 'Search'}
      </button>
    </form>
  );
}
