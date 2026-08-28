/**
 * The assembled Live Game lobby (live-game Requirements 1.3, 3).
 *
 * A header (game clock, queue, and the lobby rank spread when there is one),
 * an optional banned-champions strip, and the two teams as columns of
 * `ParticipantCard`s. The rank spread is omitted entirely when null
 * (Requirement 3.5) rather than rendered as an empty range.
 */

import type { LiveGameLobby } from '../api/types';
import { formatRankSpread, queueLabel } from '../domain/liveGame';
import { useStaticData } from '../staticData';
import { ChampionIcon } from './ChampionIcon';
import { GameClock } from './GameClock';
import { ParticipantCard } from './ParticipantCard';

export interface LiveGameViewProps {
  lobby: LiveGameLobby;
  /** Injected in tests; forwarded to the game clock. */
  now?: () => number;
}

const TEAM_ORDER = [100, 200] as const;

export function LiveGameView({ lobby, now }: LiveGameViewProps) {
  return (
    <section className="live-game" aria-label="Live game lobby" data-testid="live-game">
      <header className="live-header">
        <GameClock gameStartTime={lobby.gameStartTime} now={now} />
        <span className="live-queue">{queueLabel(lobby.queueId)}</span>
        {lobby.insights.rankSpread !== null ? (
          <span className="live-spread" data-testid="rank-spread">
            Rank spread: {formatRankSpread(lobby.insights.rankSpread)}
          </span>
        ) : null}
      </header>

      {lobby.bannedChampionIds.length > 0 ? (
        <div className="live-bans" aria-label="Banned champions" data-testid="live-bans">
          <span className="live-bans-label">Bans</span>
          {lobby.bannedChampionIds.map((id, index) => (
            <BannedChampion key={`${id}-${index}`} championId={id} />
          ))}
        </div>
      ) : null}

      <div className="live-teams">
        {TEAM_ORDER.map((teamId) => (
          <div className="live-team" key={teamId} data-testid={`team-${teamId}`}>
            {lobby.participants
              .filter((card) => card.teamId === teamId)
              .map((card, index) => (
                <ParticipantCard
                  // Riot does not always supply a puuid; fall back to a positional key.
                  key={card.puuid || `${teamId}-${card.championId}-${index}`}
                  card={card}
                  gameQueueId={lobby.queueId}
                  insights={lobby.insights}
                />
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function BannedChampion({ championId }: { championId: number }) {
  const provider = useStaticData();
  const key = provider.championKeyForId(championId) ?? String(championId);
  return <ChampionIcon championKey={key} size={22} className="live-ban" />;
}
