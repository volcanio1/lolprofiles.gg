/**
 * The Fun Facts v2 section (player-insights Requirements 2-5, 13.1, 13.5).
 *
 * Renders whatever `computeFunFactsV2` produced, in the backend's own order —
 * this component does no filtering or sorting of its own. `favoriteItems`
 * (present only on that one category) is resolved to icons/names through the
 * existing Static_Data_Provider, the same as every other item id already
 * rendered elsewhere in the report (Requirement 4.6); every other category is
 * plain prose the backend already wrote.
 */

import type { FunFactV2 } from '../api/types';
import { useStaticData } from '../staticData';
import { CdnImage } from './CdnImage';

export interface FunFactsPanelProps {
  funFacts: readonly FunFactV2[];
  /** Requirement 13.5: the existing limited-data notice, unchanged. */
  limitedDataNotice: boolean;
}

const FUN_FACT_LABELS: Readonly<Record<FunFactV2['category'], string>> = {
  nemesis: 'Nemesis',
  longestGame: 'Longest game',
  favoriteItems: 'Favorite item(s)',
  mostUsedPing: 'Most-used ping',
  averageKda: 'Average KDA',
  averageGoldDiffAt10: 'Average gold diff @ 10',
};

export function FunFactsPanel({ funFacts, limitedDataNotice }: FunFactsPanelProps) {
  if (funFacts.length === 0) {
    return (
      <p data-testid="no-fun-facts" className="empty-note">
        {limitedDataNotice
          ? 'Not enough match history to derive fun facts yet.'
          : 'Nothing to report yet — check back after a few more matches.'}
      </p>
    );
  }

  return (
    <ul className="fact-list" role="list">
      {funFacts.map((fact) => (
        <li key={fact.category} data-testid={`fun-fact-${fact.category}`} className="fact-item">
          <strong className="fact-label">{FUN_FACT_LABELS[fact.category]}</strong>
          <span className="fact-text">{fact.text}</span>
          {fact.favoriteItems !== undefined && fact.favoriteItems.length > 0 ? (
            <FavoriteItemIcons items={fact.favoriteItems} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function FavoriteItemIcons({ items }: { items: readonly { itemId: number; count: number }[] }) {
  const provider = useStaticData();
  return (
    <ul className="fact-item-list" data-testid="favorite-item-icons" role="list">
      {items.map((item) => {
        const name = provider.itemDisplayName(item.itemId);
        return (
          <li key={item.itemId} className="fact-item-row">
            <CdnImage
              url={provider.itemIconUrl(item.itemId)}
              alt={name}
              fallbackLabel={`${name} unavailable`}
              size={24}
              className="fact-item-icon"
            />
            <span className="fact-item-name">{name}</span>
            <span className="fact-item-count">{item.count}x</span>
          </li>
        );
      })}
    </ul>
  );
}
