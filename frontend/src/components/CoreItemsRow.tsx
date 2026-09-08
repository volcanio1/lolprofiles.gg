/**
 * A champion build's core item path — the first few completed items + boots, in
 * purchase order (champion-build-stats Requirement 5.3.3).
 *
 * A thin wrapper over `ItemBuildRow`'s `ItemSlot`, so the icons, hover tooltips
 * and unresolved-id degradation match the match Build Path tab exactly. Renders
 * an ordered list because purchase order is meaningful.
 */

import { ItemSlot } from './ItemBuildRow';

export interface CoreItemsRowProps {
  /** Item ids in purchase order. */
  itemIds: readonly number[];
  size?: number;
  className?: string;
}

export function CoreItemsRow({ itemIds, size = 28, className }: CoreItemsRowProps) {
  if (itemIds.length === 0) {
    return null;
  }
  return (
    <ol
      className={className === undefined ? 'core-items-row' : `core-items-row ${className}`}
      data-testid="core-items"
    >
      {itemIds.map((id, index) => (
        <li key={index} className="core-items-slot">
          <ItemSlot id={id} size={size} className="core-items-icon" />
        </li>
      ))}
    </ol>
  );
}
