/**
 * profile-sidebar Requirement 9: a Gamemode_Filter control.
 *
 * A compact horizontal tab bar (dpm.lol-style), not a dropdown — it fits the
 * narrow rail and shows every option at a glance. Stateless: `ProfileReportView`
 * owns the value and default (Requirement 9.4). Switching never hits the network
 * (Requirement 9.3) — the parent just renders a different precomputed slice.
 */

import type { QueueFilterValue } from '../api/types';

/** Short tab labels — the full names are too wide for a rail tab. */
const TAB_LABELS: Readonly<Record<QueueFilterValue, string>> = {
  all: 'All',
  'ranked solo/duo': 'Solo',
  'ranked flex': 'Flex',
  normal: 'Normal',
};

export interface GamemodeFilterProps {
  value: QueueFilterValue;
  onChange: (value: QueueFilterValue) => void;
  /** Requirement 9.1: only the values with included matches on this report. */
  availableValues: readonly QueueFilterValue[];
  /** Accessible name for the tab group. */
  label: string;
  /** `data-testid` for the tablist container; each tab gets `${testId}-<value>`. */
  testId: string;
}

export function GamemodeFilter({ value, onChange, availableValues, label, testId }: GamemodeFilterProps) {
  return (
    <div className="queue-tabs" role="tablist" aria-label={label} data-testid={testId}>
      {availableValues.map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={option === value}
          className={option === value ? 'queue-tab queue-tab--active' : 'queue-tab'}
          data-testid={`${testId}-${option.replace(/[^a-z]+/g, '-')}`}
          onClick={() => onChange(option)}
        >
          {TAB_LABELS[option]}
        </button>
      ))}
    </div>
  );
}
