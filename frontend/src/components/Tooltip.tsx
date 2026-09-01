/**
 * A hover/focus tooltip for an inline asset icon (item, rune, summoner spell).
 *
 * The bubble is rendered into a portal on `document.body` and positioned
 * `fixed` from the anchor's bounding rect, so it is never clipped by an
 * ancestor's `overflow` (the scoreboard's horizontal scroll container, the
 * expanded match panel, the page section). It flips above/below depending on
 * available room and clamps horizontally to the viewport; a very tall bubble
 * scrolls within its own `max-height` rather than running off-screen.
 *
 * It carries `role="tooltip"` wired to the anchor through `aria-describedby`.
 * The anchor is focusable (`tabIndex={0}`) so keyboard users get the same
 * content; `Escape` dismisses it.
 *
 * Layout is always name -> stats -> description: the title, then stat lines each
 * with a `StatIcon`, then the effect paragraphs. `description` is optional — a
 * name-only tooltip (rune trees, unresolved items) still renders its title.
 */

import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { AssetDescription } from '../staticData/provider';
import { StatIcon } from './StatIcon';

export interface TooltipProps {
  title: string;
  description?: AssetDescription;
  /**
   * Full custom replacement for `description`'s auto-rendered stats/paragraphs
   * (e.g. a line that needs its own color, like the rank-graph's tier-colored
   * rank/LP line) — every other call site keeps using `description`. Ignored
   * when `description` is also given; only one of the two applies.
   */
  body?: ReactNode;
  children: ReactNode;
  className?: string;
}

const GAP = 8;
const EDGE = 8;

export function Tooltip({ title, description, body, children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const bubbleId = useId();

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) {
      return;
    }
    const a = anchor.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const above = a.top - GAP - b.height >= 0 || a.top > window.innerHeight - a.bottom;
    const top = above ? a.top - GAP - b.height : a.bottom + GAP;
    const rawLeft = a.left + a.width / 2 - b.width / 2;
    const left = Math.max(EDGE, Math.min(rawLeft, window.innerWidth - b.width - EDGE));
    setCoords({ top: Math.max(EDGE, top), left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  if (title.length === 0) {
    return <>{children}</>;
  }

  const stats = description?.stats ?? [];
  const paragraphs = description?.paragraphs ?? [];

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === 'Escape' && open) {
      setOpen(false);
    }
  }

  return (
    <span
      ref={anchorRef}
      className={className ? `tooltip-anchor ${className}` : 'tooltip-anchor'}
      tabIndex={0}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={onKeyDown}
      aria-describedby={open ? bubbleId : undefined}
      data-testid="tooltip-anchor"
    >
      {children}
      {open
        ? createPortal(
            <span
              ref={bubbleRef}
              role="tooltip"
              id={bubbleId}
              className="tooltip-bubble"
              style={
                coords
                  ? { top: `${coords.top}px`, left: `${coords.left}px` }
                  : { top: 0, left: 0, visibility: 'hidden' }
              }
            >
              <strong className="tooltip-title">{title}</strong>
              {body !== undefined ? (
                <span className="tooltip-body">{body}</span>
              ) : (
                <>
                  {stats.length > 0 ? (
                    <span className="tooltip-stats">
                      {stats.map((line, index) => (
                        <span className="tooltip-stat-row" key={index}>
                          <span className="tooltip-stat-icon-slot">
                            <StatIcon stat={line.stat} className="tooltip-stat-icon" />
                          </span>
                          {line.amount ? <span className="tooltip-stat-amount">{line.amount}</span> : null}
                          <span className="tooltip-stat-name">{line.stat}</span>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {paragraphs.length > 0 ? (
                    <span className="tooltip-body">
                      {paragraphs.map((paragraph, index) => (
                        <span className="tooltip-para" key={index}>
                          {paragraph}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </>
              )}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
