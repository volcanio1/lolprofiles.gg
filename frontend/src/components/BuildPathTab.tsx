/**
 * The Build Path tab — defined here, filled by `item-timeline`.
 *
 * `match-detail-tabs` task 6.4, design.md decision 7 — Requirements 5.1, 5.2, 5.3.
 *
 * An empty tab reads as a bug; a spinner that never resolves reads as a worse
 * one. This renders an explicit "not yet available" message and retrieves
 * nothing — Requirement 5.3 forbids fetching a Match_Timeline as part of
 * assembling or rendering a Profile_Report, and this component issues no
 * request at all. `matchId` is accepted now, unused, so `item-timeline` can
 * wire retrieval in without changing this component's call site.
 */

export interface BuildPathTabProps {
  matchId: string;
}

export function BuildPathTab({ matchId }: BuildPathTabProps) {
  return (
    <p className="build-path-unavailable" data-testid={`build-path-${matchId}-unavailable`}>
      Build Path is not yet available for this match.
    </p>
  );
}
