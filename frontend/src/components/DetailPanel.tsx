/**
 * The collapsible region beneath a `MatchRow`, presenting the General, Build
 * Path, and Runes tabs — Augments in place of Runes for an ARAM Mayhem match
 * (queue 2400), since those participants have no meaningful rune page.
 *
 * `match-detail-tabs` task 6.1 — Requirements 2.3, 2.4, 2.5, 2.6, 2.7.
 * Task 9.5 adds the queue-based swap — Requirements 11.7, 12.3, 12.4.
 *
 * ---------------------------------------------------------------------------
 * WHY EXPANSION AND TAB SELECTION LIVE IN `MatchRow`, NOT HERE
 * ---------------------------------------------------------------------------
 *
 * Requirement 2.4 restores whichever tab a row had selected the last time it
 * was collapsed. This component is only rendered while its row is expanded
 * (`MatchRow` conditionally mounts it), so if `selectedTab` were local state
 * here, it would reset to the default on every collapse-then-expand cycle —
 * exactly the behaviour the requirement forbids. `MatchRow` owns both pieces of
 * state and passes them down as controlled props, so they survive this
 * component unmounting and remounting.
 *
 * ---------------------------------------------------------------------------
 * TAB SEMANTICS: WAI-ARIA "AUTOMATIC ACTIVATION"
 * ---------------------------------------------------------------------------
 *
 * Left/Right moves focus AND selection together (rather than moving focus only,
 * with a separate activation key) — the simpler of the two standard patterns,
 * and adequate here since selecting a tab has no destructive or expensive side
 * effect (Requirement 2.7: no request is ever issued by doing so).
 */

import { useRef } from 'react';
import type { RecentMatchSummary } from '../api/types';
import { AugmentsTab } from './AugmentsTab';
import { BuildPathTab } from './BuildPathTab';
import { GeneralTab } from './GeneralTab';
import { RunesTab } from './RunesTab';

export type DetailTabKey = 'general' | 'buildPath' | 'runes';

/**
 * Requirement 11.7/12.3: the third tab's KEY stays `'runes'` regardless of
 * queue — `MatchRow`'s per-row selected-tab state has no reason to know that
 * ARAM Mayhem swaps its content and label. Only the label and rendered
 * content are queue-dependent.
 */
function thirdTabLabel(queueType: string): string {
  return queueType === 'aram mayhem' ? 'Augments' : 'Runes';
}

export interface DetailPanelProps {
  match: RecentMatchSummary;
  selectedTab: DetailTabKey;
  onSelectTab: (tab: DetailTabKey) => void;
}

export function DetailPanel({ match, selectedTab, onSelectTab }: DetailPanelProps) {
  const tabRefs = useRef<Partial<Record<DetailTabKey, HTMLButtonElement | null>>>({});
  const isAugments = match.queueType === 'aram mayhem';

  /** Requirement 2.3: exactly three tabs, in this order. */
  const TABS: readonly { key: DetailTabKey; label: string }[] = [
    { key: 'general', label: 'General' },
    { key: 'buildPath', label: 'Build Path' },
    { key: 'runes', label: thirdTabLabel(match.queueType) },
  ];

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const nextTab = TABS[(currentIndex + delta + TABS.length) % TABS.length];
    onSelectTab(nextTab.key);
    tabRefs.current[nextTab.key]?.focus();
  }

  const tabId = (key: DetailTabKey) => `match-detail-tab-${match.matchId}-${key}`;
  const panelId = (key: DetailTabKey) => `match-detail-tabpanel-${match.matchId}-${key}`;

  return (
    <div className="detail-panel" data-testid={`detail-panel-${match.matchId}`}>
      <div role="tablist" aria-label="Match detail" className="detail-tablist">
        {TABS.map((tab, index) => {
          const selected = tab.key === selectedTab;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={tabId(tab.key)}
              aria-selected={selected}
              aria-controls={panelId(tab.key)}
              tabIndex={selected ? 0 : -1}
              className={selected ? 'detail-tab detail-tab--selected' : 'detail-tab'}
              onClick={() => onSelectTab(tab.key)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              ref={(element) => {
                tabRefs.current[tab.key] = element;
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/*
       * Only the selected tab's content is mounted at all — not rendered-and-hidden.
       * This matters beyond visual state: Requirement 5.4 requires the Build Path
       * tab to retrieve its data only in response to being selected, never merely
       * because the panel expanded or another tab is active. A permanently-mounted
       * `BuildPathTab` behind a `hidden` attribute would fetch the moment the panel
       * first rendered — this component doesn't fetch yet, but the tab-mounting
       * discipline is established now so `item-timeline` inherits it for free.
       */}
      <div role="tabpanel" id={panelId(selectedTab)} aria-labelledby={tabId(selectedTab)} className="detail-tabpanel">
        {selectedTab === 'general' ? <GeneralTab participants={match.participants} /> : null}
        {selectedTab === 'buildPath' ? <BuildPathTab matchId={match.matchId} /> : null}
        {selectedTab === 'runes' && isAugments ? <AugmentsTab participants={match.participants} /> : null}
        {selectedTab === 'runes' && !isAugments ? <RunesTab participants={match.participants} /> : null}
      </div>
    </div>
  );
}
