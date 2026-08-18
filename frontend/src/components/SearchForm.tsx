/**
 * Riot ID search form with region and platform selectors.
 *
 * Implements:
 *  - 1.1: a text input accepting `gameName#tagLine`.
 *  - 1.2: a well-formed value initiates a Lookup_Session.
 *  - 1.3-1.5 / 9.1: a malformed value is rejected on submit and a message naming
 *    the specific rule that failed is displayed, without dispatching anything.
 *  - 1.6: the region defaults to `americas`.
 *  - 1.7: the region selector offers exactly the four supported regions.
 *  - 5.3: the platform choices are exactly the selected region's members.
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
 * 2. THE PLATFORM SELECTOR OFFERS AN EXPLICIT "ANY" OPTION, AND IT IS THE DEFAULT.
 *    Requirement 5.4 has the backend substitute the region's first platform when
 *    none applies, so "any" is not a fiction — it is the documented behavior, and
 *    naming it is more honest than pre-selecting a specific platform the visitor
 *    never chose. Requirement 1.6 only fixes a default for the REGION, so leaving
 *    the platform unset is permitted.
 *
 * 3. CHANGING REGION RESETS A PLATFORM THAT NO LONGER BELONGS TO IT. Requirement
 *    5.3 restricts the choices to the selected region, so a stale selection must not
 *    survive; silently keeping `euw1` after switching to `asia` would submit a pair
 *    the backend has to correct under 5.4, which is a worse outcome than resetting.
 *
 * 4. THE ERROR IS WIRED UP FOR ASSISTIVE TECHNOLOGY, not merely displayed:
 *    `aria-invalid` marks the field, `aria-describedby` ties the message to it, and
 *    `role="alert"` announces it. A validation message a screen-reader user cannot
 *    perceive does not satisfy "display a message" in any useful sense.
 */

import { useId, useState, type FormEvent } from 'react';
import {
  DEFAULT_REGION,
  PLATFORM_LABELS,
  REGION_LABELS,
  SUPPORTED_REGIONS,
  platformBelongsTo,
  platformsFor,
  type RegionalRoutingValue,
} from '../domain/regions';
import { RIOT_ID_ERROR_DISPLAY, validateRiotId } from '../domain/riotId';

export interface SearchSubmission {
  /** The raw, trimmed `gameName#tagLine` value; the backend re-validates it. */
  riotId: string;
  region: RegionalRoutingValue;
  /** Absent means "any platform in this region" (decision 2). */
  platform?: string;
}

export interface SearchFormProps {
  onSubmit: (submission: SearchSubmission) => void;
  /** Prefills when returning to the form from a report. */
  initialRiotId?: string;
  initialRegion?: RegionalRoutingValue;
  initialPlatform?: string;
  /** Disables submission while a lookup is in flight. */
  busy?: boolean;
}

/** Sentinel for decision 2's "any platform" option. */
const ANY_PLATFORM = '';

export function SearchForm({
  onSubmit,
  initialRiotId = '',
  initialRegion = DEFAULT_REGION,
  initialPlatform = ANY_PLATFORM,
  busy = false,
}: SearchFormProps) {
  const [riotId, setRiotId] = useState(initialRiotId);
  const [region, setRegion] = useState<RegionalRoutingValue>(initialRegion);
  const [platform, setPlatform] = useState<string>(initialPlatform);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const riotIdInputId = useId();
  const riotIdErrorId = useId();
  const regionSelectId = useId();
  const platformSelectId = useId();

  function handleRegionChange(next: RegionalRoutingValue) {
    setRegion(next);
    // Decision 3.
    if (platform !== ANY_PLATFORM && !platformBelongsTo(next, platform)) {
      setPlatform(ANY_PLATFORM);
    }
  }

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
    onSubmit({
      riotId: `${validation.riotId.gameName}#${validation.riotId.tagLine}`,
      region,
      platform: platform === ANY_PLATFORM ? undefined : platform,
    });
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
          // Decision 4.
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

      {/* Requirement 1.7 */}
      <div className="field">
        <label htmlFor={regionSelectId} className="field-label">
          Region
        </label>
        <select
          id={regionSelectId}
          name="region"
          value={region}
          className="field-select"
          onChange={(event) => {
            handleRegionChange(event.target.value as RegionalRoutingValue);
          }}
        >
          {SUPPORTED_REGIONS.map((value) => (
            <option key={value} value={value}>
              {REGION_LABELS[value]}
            </option>
          ))}
        </select>
      </div>

      {/* Requirement 5.3: exactly the selected region's platforms */}
      <div className="field">
        <label htmlFor={platformSelectId} className="field-label">
          Platform
        </label>
        <select
          id={platformSelectId}
          name="platform"
          value={platform}
          className="field-select"
          onChange={(event) => {
            setPlatform(event.target.value);
          }}
        >
          <option value={ANY_PLATFORM}>Any platform in this region</option>
          {platformsFor(region).map((value) => (
            <option key={value} value={value}>
              {PLATFORM_LABELS[value]}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" disabled={busy} className="btn btn-primary">
        {busy ? 'Searching…' : 'Search'}
      </button>
    </form>
  );
}
