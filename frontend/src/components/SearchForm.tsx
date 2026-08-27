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
 *    not display either selector — there is no longer a legitimate value for a
 *    visitor to pick, since the backend's Region Resolver determines the
 *    platform from the Riot ID itself. A hidden-but-present selector would
 *    invite exactly the confusion this feature removes.
 */

import { useId, useState, type FormEvent } from 'react';
import { RIOT_ID_ERROR_DISPLAY, validateRiotId } from '../domain/riotId';

export interface SearchSubmission {
  /** The raw, trimmed `gameName#tagLine` value; the backend re-validates it. */
  riotId: string;
}

export interface SearchFormProps {
  onSubmit: (submission: SearchSubmission) => void;
  /** Prefills when returning to the form from a report. */
  initialRiotId?: string;
  /** Disables submission while a lookup is in flight. */
  busy?: boolean;
}

export function SearchForm({ onSubmit, initialRiotId = '', busy = false }: SearchFormProps) {
  const [riotId, setRiotId] = useState(initialRiotId);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const riotIdInputId = useId();
  const riotIdErrorId = useId();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Requirements 1.3-1.5 / 9.1: reject before dispatching anything.
    const validation = validateRiotId(riotId);
    if (!validation.ok) {
      setErrorMessage(RIOT_ID_ERROR_DISPLAY[validation.errorCode].message);
      return;
    }

    setErrorMessage(undefined);
    // Requirement 1.2: a well-formed value initiates the Lookup_Session.
    onSubmit({ riotId: `${validation.riotId.gameName}#${validation.riotId.tagLine}` });
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Player search" noValidate className="search-form">
      <div className="field">
        <label htmlFor={riotIdInputId} className="field-label">
          Riot ID
        </label>
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
          onChange={(event) => {
            setRiotId(event.target.value);
            // Decision 1: an edit clears a message that may no longer apply.
            if (errorMessage !== undefined) {
              setErrorMessage(undefined);
            }
          }}
        />
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
