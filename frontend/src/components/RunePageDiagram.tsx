/**
 * A champion build's rune page drawn the way the in-game client draws it: both
 * trees in full, every rune shown, the picked ones lit and the rest greyed out —
 * keystone row, three minor rows, the secondary tree's three rows, and the three
 * stat-shard rows.
 *
 * champion-build-stats: used by `ChampionBuildPanel` in place of the compact
 * `RunePageCard` (which the match Runes tab still uses). The tree layout comes
 * from `provider.runeTreeSlots`; when that is empty (index not ready, or
 * `runesReforged.json` carried no structure) this falls back to showing only the
 * picked runes, so it degrades to the old compact view rather than a blank grid.
 *
 * The `null` / unavailable branch keeps this component's own empty state and the
 * `${testId}-unavailable` hook, matching `RunePageCard` so `ChampionBuildPanel`'s
 * callers need no separate handling (Requirement 7.3).
 */

import type { RunePage } from '../api/types';
import { isRunePageUnavailable } from '../domain/participantOrder';
import { useStaticData } from '../staticData';
import { RuneIcon } from './RuneIcon';
import { RuneTreeIcon } from './RuneTreeIcon';
import { StatShardIcon } from './StatShardIcon';

export interface RunePageDiagramProps {
  runes: RunePage | null;
  /** Stem for `data-testid` (and `-unavailable`); omitted = no testids. */
  testId?: string;
  unavailableText?: string;
}

/**
 * The three stat-shard rows — offense, flex, defense — with the option in each.
 * Data Dragon publishes no metadata for these (see `provider`'s
 * `STAT_SHARD_TABLE`), so the layout is fixed here, matching the live client.
 */
const STAT_SHARD_ROWS: readonly (readonly number[])[] = [
  [5008, 5005, 5007], // Adaptive Force · Attack Speed · Ability Haste
  [5008, 5010, 5001], // Adaptive Force · Move Speed · Health Scaling
  [5011, 5013, 5001], // Health · Tenacity & Slow Resist · Health Scaling
];

function RuneCell({
  runeId,
  size,
  selected,
  keystone = false,
}: {
  runeId: number;
  size: number;
  selected: boolean;
  keystone?: boolean;
}) {
  const classes = ['rune-cell'];
  if (selected) classes.push('rune-cell--on');
  else classes.push('rune-cell--off');
  if (keystone) classes.push('rune-cell--keystone');
  return (
    <span className={classes.join(' ')}>
      <RuneIcon runeId={runeId} size={size} />
    </span>
  );
}

function ShardCell({ shardId, selected }: { shardId: number; selected: boolean }) {
  return (
    <span className={`rune-cell rune-cell--shard ${selected ? 'rune-cell--on' : 'rune-cell--off'}`}>
      <StatShardIcon shardId={shardId} size={20} />
    </span>
  );
}

export function RunePageDiagram({
  runes,
  testId,
  unavailableText = 'Not enough data for a rune page yet.',
}: RunePageDiagramProps) {
  const provider = useStaticData();

  if (runes === null || isRunePageUnavailable(runes)) {
    return (
      <p
        data-testid={testId === undefined ? undefined : `${testId}-unavailable`}
        className="rune-page-unavailable"
      >
        {unavailableText}
      </p>
    );
  }

  const primarySlots = provider.runeTreeSlots(runes.primaryStyle);
  const secondarySlots = provider.runeTreeSlots(runes.secondaryStyle);
  const hasStructure = primarySlots.length > 0 && secondarySlots.length > 0;

  const primaryPicked = new Set(runes.primarySelections);
  const secondaryPicked = new Set(runes.secondarySelections);

  // Fallback: no published tree structure — show only what was picked, the same
  // three visually-distinct groups the compact card uses.
  if (!hasStructure) {
    return (
      <div data-testid={testId} className="rune-diagram rune-diagram--compact">
        <div className="rune-group rune-group--primary">
          <RuneTreeIcon styleId={runes.primaryStyle} size={20} className="rune-group-tree-icon" />
          {runes.primarySelections.map((runeId, index) => (
            <RuneIcon key={index} runeId={runeId} size={16} />
          ))}
        </div>
        <div className="rune-group rune-group--secondary">
          <RuneTreeIcon styleId={runes.secondaryStyle} size={20} className="rune-group-tree-icon" />
          {runes.secondarySelections.map((runeId, index) => (
            <RuneIcon key={index} runeId={runeId} size={16} />
          ))}
        </div>
        <div className="rune-group rune-group--shards">
          {runes.statShards.map((shardId, index) => (
            <StatShardIcon key={index} shardId={shardId} size={16} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div data-testid={testId} className="rune-diagram">
      <div className="rune-diagram-tree rune-diagram-tree--primary">
        <div className="rune-diagram-tree-head">
          <RuneTreeIcon styleId={runes.primaryStyle} size={22} />
          <span>{provider.runeTreeDisplayName(runes.primaryStyle)}</span>
        </div>
        {primarySlots.map((slot, rowIndex) => (
          <div
            key={rowIndex}
            className={`rune-diagram-row${rowIndex === 0 ? ' rune-diagram-row--keystone' : ''}`}
          >
            {slot.map((runeId) => (
              <RuneCell
                key={runeId}
                runeId={runeId}
                size={rowIndex === 0 ? 40 : 30}
                keystone={rowIndex === 0}
                selected={primaryPicked.has(runeId)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="rune-diagram-tree rune-diagram-tree--secondary">
        <div className="rune-diagram-tree-head">
          <RuneTreeIcon styleId={runes.secondaryStyle} size={22} />
          <span>{provider.runeTreeDisplayName(runes.secondaryStyle)}</span>
        </div>
        {secondarySlots.slice(1).map((slot, rowIndex) => (
          <div key={rowIndex} className="rune-diagram-row">
            {slot.map((runeId) => (
              <RuneCell key={runeId} runeId={runeId} size={30} selected={secondaryPicked.has(runeId)} />
            ))}
          </div>
        ))}

        <div className="rune-diagram-shards">
          <span className="rune-diagram-shards-label">Stat shards</span>
          {STAT_SHARD_ROWS.map((row, rowIndex) => (
            <div key={rowIndex} className="rune-diagram-row rune-diagram-row--shard">
              {row.map((shardId, cellIndex) => (
                <ShardCell
                  key={cellIndex}
                  shardId={shardId}
                  selected={runes.statShards[rowIndex] === shardId}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
