/**
 * A champion build's core item path — the completed items in purchase order,
 * shown as a left-to-right flow with arrows between positions
 * (champion-build-stats Requirement 5.3.3).
 *
 * Each position is a slot: usually one item, but two when the backend found a
 * near-equally-built alternative — shown as `A / B` so both viable choices are
 * visible. A thin wrapper over `ItemBuildRow`'s `ItemSlot`, so icons, hover
 * tooltips and unresolved-id degradation match the match Build Path tab exactly.
 */

import { Fragment } from 'react';
import type { ChampionCoreItemSlot } from '../api/types';
import { ItemSlot } from './ItemBuildRow';

export interface CoreItemsRowProps {
  /** One slot per purchase position; each slot has 1-2 item ids. */
  slots: readonly ChampionCoreItemSlot[];
  size?: number;
  className?: string;
}

export function CoreItemsRow({ slots, size = 32, className }: CoreItemsRowProps) {
  if (slots.length === 0) {
    return null;
  }
  return (
    <ol
      className={className === undefined ? 'core-items-row' : `core-items-row ${className}`}
      data-testid="core-items"
    >
      {slots.map((slot, index) => (
        <li key={index} className="core-items-slot">
          {slot.map((id, option) => (
            <Fragment key={option}>
              {option > 0 ? <span className="core-items-or">/</span> : null}
              <ItemSlot id={id} size={size} className="core-items-icon" />
            </Fragment>
          ))}
        </li>
      ))}
    </ol>
  );
}
