/**
 * Wraps a player's Riot ID in a link to their profile report
 * (`/profile?riotId=gameName%23tagLine`) — used everywhere a player tag is
 * shown as text: the match scoreboard, the mirrored match row, live-game
 * participant cards, premades, and Clash roster cards.
 *
 * Inherits the surrounding text's size/color (`.player-link` in styles.css) so
 * it reads as a normal name in place, not a generic blue link, with an
 * underline-on-hover affordance that it's clickable.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { profileHref } from '../domain/profileLink';

export interface PlayerLinkProps {
  gameName: string;
  tagLine: string;
  className?: string;
  children: ReactNode;
}

export function PlayerLink({ gameName, tagLine, className, children }: PlayerLinkProps) {
  return (
    <Link
      to={profileHref(gameName, tagLine)}
      className={className === undefined ? 'player-link' : `player-link ${className}`}
      data-testid="player-link"
    >
      {children}
    </Link>
  );
}
