/**
 * Renders a rune tree's Data Dragon icon, or an Asset_Placeholder naming the
 * tree when it cannot be resolved.
 *
 * `match-detail-tabs` task 4.3 — Requirements 7.11, 8.1, 8.3, 8.4. Resolved
 * against the UNVERSIONED path (Requirement 7.4), same as `RuneIcon`.
 *
 * When `selectionIds` is passed (the compact loadout views, where the individual
 * secondary runes are not shown on their own), the hover tooltip expands to list
 * each picked rune in that tree with its description — otherwise it is just the
 * tree name.
 */

import { useStaticData } from '../staticData';
import type { AssetDescription } from '../staticData/provider';
import { CdnImage } from './CdnImage';
import { Tooltip } from './Tooltip';

export interface RuneTreeIconProps {
  styleId: number;
  size: number;
  className?: string;
  /** Rune ids picked in this tree; when set, the tooltip lists each with its description. */
  selectionIds?: readonly number[];
}

/**
 * One paragraph per picked rune: `Rune Name` on its own line, then its effect
 * text. Empty-slot ids (`0`) are dropped. Pure so it can be tested without a
 * provider or a DOM.
 */
export function secondaryRuneParagraphs(
  ids: readonly number[],
  runeName: (id: number) => string,
  runeDescription: (id: number) => AssetDescription,
): string[] {
  return ids
    .filter((id) => id !== 0)
    .map((id) => {
      const text = runeDescription(id).paragraphs.join(' ');
      return text.length > 0 ? `${runeName(id)}\n${text}` : runeName(id);
    });
}

export function RuneTreeIcon({ styleId, size, className, selectionIds }: RuneTreeIconProps) {
  const provider = useStaticData();
  const url = provider.runeTreeIconUrl(styleId);
  const name = provider.runeTreeDisplayName(styleId);

  let description: AssetDescription | undefined;
  if (selectionIds && selectionIds.length > 0) {
    const paragraphs = secondaryRuneParagraphs(
      selectionIds,
      (id) => provider.runeDisplayName(id),
      (id) => provider.runeDescription(id),
    );
    if (paragraphs.length > 0) {
      description = { stats: [], paragraphs };
    }
  }

  return (
    <Tooltip title={name} description={description}>
      <CdnImage url={url} alt={name} fallbackLabel={`${name} unavailable`} size={size} className={className} />
    </Tooltip>
  );
}
