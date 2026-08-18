/**
 * Loading indicator for an in-flight Lookup_Session.
 *
 * Implements Requirement 9.6: displayed WHILE a lookup is in progress. The
 * complement, Requirement 9.7, is not this component's concern — it is guaranteed
 * by `useLookup` clearing `loading` in a `finally` covering success, every error
 * branch, and the client-side timeout, so this component simply unmounts.
 *
 * `role="status"` with `aria-live="polite"` announces the state change without
 * stealing focus, which is the right register for "please wait": a visitor using a
 * screen reader learns the lookup started without being interrupted mid-sentence.
 */
export function LoadingIndicator({ label = 'Looking up this player…' }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" data-testid="loading-indicator" className="loader">
      {label}
    </p>
  );
}
