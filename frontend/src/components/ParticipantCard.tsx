/**
 * One player's card in a Live Game lobby (live-game Requirements 1.3, 2, 3, 7).
 *
 *  - 7.1/7.5: champion, spells and the keystone rune resolve through the
 *    Static_Data_Provider; a numeric champion id that the pinned release does not
 *    know still renders (the id as text, no icon) rather than failing the card.
 *  - 2.5: a bot renders as a bot, with no rank or mastery.
 *  - 2.6: a player with no ranked entry for the game's queue renders as
 *    "Unranked" — distinct from a player whose enrichment failed (nothing shown).
 *  - 3.2/3.3: the off-champion and one-trick flags are surfaced here, driven by
 *    the lobby-level insight lists.
 */

import type { LiveParticipantCard, LobbyInsights } from '../api/types';
import { useStaticData } from '../staticData';
import { formatMasteryPoints, formatRank, rankedEntryForGame } from '../domain/liveGame';
import { CdnImage } from './CdnImage';
import { PlayerLink } from './PlayerLink';
import { RankIcon } from './RankIcon';
import { RuneIcon } from './RuneIcon';
import { SummonerSpellIcon } from './SummonerSpellIcon';

export interface ParticipantCardProps {
  card: LiveParticipantCard;
  gameQueueId: number;
  insights: LobbyInsights;
}

export function ParticipantCard({ card, gameQueueId, insights }: ParticipantCardProps) {
  const provider = useStaticData();
  const championKey = provider.championKeyForId(card.championId) ?? String(card.championId);
  const championName = provider.championDisplayName(championKey);

  const name = card.isBot
    ? 'Bot'
    : card.riotId !== null
      ? `${card.riotId.gameName}#${card.riotId.tagLine}`
      : 'Unknown player';

  const rankedEntry = card.isBot ? undefined : rankedEntryForGame(card, gameQueueId);
  // A successful League call that carried nothing for this queue is "Unranked";
  // `rankedEntries === null` is a failed call, so render nothing at all then.
  const showUnranked = !card.isBot && card.rankedEntries !== null && rankedEntry === undefined;

  const isOffChampion = insights.offChampion.includes(card.puuid);
  const isOneTrick = insights.oneTricks.includes(card.puuid);

  return (
    <div
      className={`live-card${card.isBot ? ' live-card--bot' : ''}`}
      data-testid="participant-card"
      data-puuid={card.puuid}
    >
      <div className="live-card-champ-block">
        <CdnImage
          url={provider.championIconUrl(championKey)}
          alt={championName}
          fallbackLabel={`${championName} icon unavailable`}
          size={40}
          className="live-card-champ"
        />
        <span className="live-card-champ-name">{championName}</span>
      </div>

      <div className="live-card-loadout">
        <SummonerSpellIcon spellId={card.spell1Id} size={16} />
        <SummonerSpellIcon spellId={card.spell2Id} size={16} />
        {card.perkIds.length > 0 ? <RuneIcon runeId={card.perkIds[0]} size={16} /> : null}
      </div>

      <div className="live-card-identity">
        <span className="live-card-name" title={name}>
          {!card.isBot && card.riotId !== null ? (
            <PlayerLink gameName={card.riotId.gameName} tagLine={card.riotId.tagLine}>
              {name}
            </PlayerLink>
          ) : (
            name
          )}
        </span>
        <span className="live-card-rank">
          {rankedEntry !== undefined ? (
            <>
              <RankIcon tier={rankedEntry.tier} size={16} className="live-card-crest" />
              {formatRank(rankedEntry)}
            </>
          ) : showUnranked ? (
            'Unranked'
          ) : null}
        </span>
      </div>

      <div className="live-card-meta">
        {card.championMasteryPoints !== null ? (
          <span className="live-card-mastery" data-testid="participant-mastery">
            {formatMasteryPoints(card.championMasteryPoints)} pts
          </span>
        ) : null}
        {isOneTrick ? (
          <span className="live-flag live-flag--onetrick" data-testid="flag-onetrick">
            One-trick
          </span>
        ) : null}
        {isOffChampion ? (
          <span className="live-flag live-flag--offchamp" data-testid="flag-offchamp">
            Off-champ
          </span>
        ) : null}
      </div>
    </div>
  );
}
