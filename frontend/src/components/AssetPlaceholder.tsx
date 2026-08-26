/**
 * Stands in for a Data Dragon asset that could not be resolved.
 *
 * Task 2.4 — Requirements 5.1 and 6.4.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIZE IS REQUIRED RATHER THAN DEFAULTED
 * ---------------------------------------------------------------------------
 *
 * Requirement 5.1 is about layout stability, not decoration: a match history is a
 * dense grid, and an asset that resolves to nothing must occupy exactly the box its
 * image would have occupied or every row beneath it shifts. A default size would
 * silently produce the wrong box at any call site that forgot to pass one, which is
 * the precise failure this component exists to prevent — so `size` has no default
 * and callers pass the same value they give the image they are replacing.
 *
 * The dimensions are applied as an inline style rather than through a class because
 * they vary per call site (a champion icon in a match row and a profile avatar are
 * different sizes), and a class per size would be a token system for something that
 * is genuinely a per-instance measurement.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED DECISIONS
 * ---------------------------------------------------------------------------
 *
 * 1. `role="img"` WITH `aria-label`, NOT `aria-hidden`. Requirement 6.4 wants a
 *    text alternative describing what could not be loaded, so a screen reader
 *    learns that something is missing rather than encountering silence where the
 *    page visually shows a gap. Hiding it would make the absence undetectable to a
 *    non-visual reader while remaining obvious to a visual one.
 *
 * 2. THE LABEL DESCRIBES THE ABSENCE, NOT THE SUBJECT. "Champion icon unavailable"
 *    rather than "Wukong": the champion's name is already rendered as text beside
 *    the icon at every call site (Requirement 6.5), so repeating it here would make
 *    a screen reader say it twice and would misrepresent a missing image as a
 *    present one.
 *
 * 3. NO ERROR STYLING. An unresolvable asset is an ordinary outcome — an item
 *    removed from the game since the pinned patch, a champion released after it, a
 *    profile icon that never loaded. It is drawn as a neutral empty surface, not as
 *    a warning, because nothing is wrong with the page.
 */

export interface AssetPlaceholderProps {
  /**
   * Edge length in pixels. MUST be the same value passed to the asset this stands
   * in for, or the layout shifts when an image fails to resolve (Requirement 5.1).
   */
  size: number;
  /** Describes what could not be loaded, e.g. "Champion icon unavailable". */
  label: string;
  /** Additional class for call-site shaping, e.g. a circular profile avatar. */
  className?: string;
}

export function AssetPlaceholder({ size, label, className }: AssetPlaceholderProps) {
  return (
    <span
      role="img"
      aria-label={label}
      data-testid="asset-placeholder"
      className={className ? `asset-placeholder ${className}` : 'asset-placeholder'}
      style={{ width: `${size}px`, height: `${size}px` }}
    />
  );
}
