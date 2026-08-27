/**
 * The Build Path tab — the placeholder that `match-detail-tabs` shipped, now
 * filled by `item-timeline`.
 *
 * `item-timeline` task 8.2 — Requirements 1.1, 3.5, 3.6, 3.8, 3.9, 3.10, 4.3,
 * 6.1, 6.4, 7.3.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. THE FETCH FIRES ON MOUNT, WHICH IS TAB SELECTION. `DetailPanel` mounts only
 *    the selected tab's content, so this component exists exactly when the Build
 *    Path tab is selected and not before — expanding a row, or viewing General or
 *    Runes, issues no request (Requirement 3.9 / `match-detail-tabs` 2.7). The
 *    report load never touches this path (Requirement 1.1 / 6.4).
 *
 * 2. EVERY OUTCOME RENDERS INSIDE THE TAB (Requirement 3.10). A missing timeline,
 *    a player absent from it, and a transport error all render as a line within
 *    this panel — never as a page-level error. The rest of the match row, its
 *    Final_Builds, and the other two tabs are untouched.
 *
 * 3. NOTHING IS RENDERED FOR THE LANE OPPONENT (Requirement 3.5 / 3.6). This tab
 *    shows one player's build path — the analyzed player's. The opponent's
 *    Final_Build stays where `visual-assets` put it, in the mirrored summary row.
 *
 * 4. A LATE RESPONSE AFTER UNMOUNT IS DISCARDED. Selecting away from the tab
 *    unmounts this component; `fetchBuildPath` still settles, so a `cancelled`
 *    guard keeps it from setting state on a gone component.
 *
 * 5. RIOT COMPLIANCE IS INHERITED, NOT RE-IMPLEMENTED (task 8.3 — Requirements
 *    8.1-8.3). A Build_Path only ever renders inside `ProfileReportPage`, which
 *    wraps everything in `RiotDataPage` — so the attribution statement and the
 *    no-advertising default already cover this tab. `BuildPathView` serves item
 *    images as bare `<img src={ddragon-url}>`, unaltered, exactly as
 *    `ItemBuildRow` does. Nesting a second `RiotDataPage` here would duplicate
 *    the masthead and attribution, so it is deliberately not done.
 */

import { useEffect, useState } from 'react';
import { fetchBuildPath, type BuildPathOutcome } from '../api/lookupClient';
import type { ItemBuild, RiotIdParts } from '../api/types';
import { BuildPathView } from './BuildPathView';
import { LoadingIndicator } from './LoadingIndicator';
import { SkillOrderView } from './SkillOrderView';

export interface BuildPathTabProps {
  matchId: string;
  /** The analyzed player's Riot ID — the account this tab retrieves a build path for. */
  riotId: RiotIdParts;
  /** The analyzed player's reported final build — used to show the trinket. */
  finalBuild: ItemBuild;
  /** The analyzed player's champion key — for the skill-order ability icons. */
  championName: string;
}

type TabState = { status: 'loading' } | { status: 'loaded'; outcome: BuildPathOutcome };

export function BuildPathTab({ matchId, riotId, finalBuild, championName }: BuildPathTabProps) {
  const [state, setState] = useState<TabState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void fetchBuildPath(matchId, riotId).then((outcome) => {
      if (!cancelled) {
        setState({ status: 'loaded', outcome });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [matchId, riotId]);

  if (state.status === 'loading') {
    return <LoadingIndicator label="Loading build path…" />;
  }

  const { outcome } = state;

  if (outcome.kind === 'build_path') {
    return (
      <div className="build-path-tab">
        <SkillOrderView championName={championName} skillOrder={outcome.skillOrder} />
        <BuildPathView buildPath={outcome.buildPath} reconciled={outcome.reconciled} finalBuild={finalBuild} />
      </div>
    );
  }

  // Requirement 3.10 / 6.1: the unavailable and error states are a line inside
  // the tab, not a page-level error.
  return (
    <p className="build-path-unavailable" data-testid={`build-path-${matchId}-unavailable`}>
      {outcome.kind === 'unavailable'
        ? 'Build path is not available for this match.'
        : 'Build path could not be loaded. Try selecting the tab again.'}
    </p>
  );
}
