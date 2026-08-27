/**
 * The icon for a champion stat, shown in the asset tooltip's stats block next to
 * the number (e.g. a sword beside "75 Attack Damage").
 *
 * Riot publishes an individual icon for only ~10 stats (the rune stat-mod set);
 * the rest — Lethality, Crit, Magic Penetration, Life Steal, Mana, the regens —
 * exist only inside game-client sprite atlases. To get a complete, visually
 * consistent set we bundle the League of Legends Wiki's coloured stat-icon set
 * (Riot's in-game glyphs, community-mirrored) from `src/assets/stat-icons/` —
 * see the NOTICE there. Each is cropped and re-centred on a uniform 48px canvas
 * so they all carry the same visual weight, and quantized to ~1 KB so Vite
 * inlines them into the bundle: no runtime request, no external dependency.
 *
 * "Cooldown" (summoner-spell cooldown line) uses Riot's own client clock glyph,
 * inlined verbatim. An unrecognized stat renders nothing (plain text), matching
 * the in-client shop.
 */

import adaptiveForce from '../assets/stat-icons/adaptive-force.png';
import abilityHaste from '../assets/stat-icons/ability-haste.png';
import abilityPower from '../assets/stat-icons/ability-power.png';
import armor from '../assets/stat-icons/armor.png';
import armorPen from '../assets/stat-icons/armor-pen.png';
import attackDamage from '../assets/stat-icons/attack-damage.png';
import attackSpeed from '../assets/stat-icons/attack-speed.png';
import critChance from '../assets/stat-icons/crit-chance.png';
import critDamage from '../assets/stat-icons/crit-damage.png';
import gold from '../assets/stat-icons/gold.png';
import healShieldPower from '../assets/stat-icons/heal-shield-power.png';
import health from '../assets/stat-icons/health.png';
import healthRegen from '../assets/stat-icons/health-regen.png';
import lifeSteal from '../assets/stat-icons/life-steal.png';
import magicPen from '../assets/stat-icons/magic-pen.png';
import magicResist from '../assets/stat-icons/magic-resist.png';
import mana from '../assets/stat-icons/mana.png';
import manaRegen from '../assets/stat-icons/mana-regen.png';
import moveSpeed from '../assets/stat-icons/move-speed.png';
import omnivamp from '../assets/stat-icons/omnivamp.png';
import tenacity from '../assets/stat-icons/tenacity.png';

export interface StatIconProps {
  stat: string;
  size?: number;
  className?: string;
}

const STAT_ICON: Readonly<Record<string, string>> = {
  ad: attackDamage,
  ap: abilityPower,
  as: attackSpeed,
  ah: abilityHaste,
  armor,
  mr: magicResist,
  health,
  'health-regen': healthRegen,
  ms: moveSpeed,
  tenacity,
  adaptive: adaptiveForce,
  'armor-pen': armorPen,
  'magic-pen': magicPen,
  'crit-chance': critChance,
  'crit-damage': critDamage,
  lifesteal: lifeSteal,
  omnivamp,
  'heal-shield': healShieldPower,
  mana,
  'mana-regen': manaRegen,
  gold,
};

/**
 * Normalizes a Data Dragon stat name to a `STAT_ICON` key, or `''` when none
 * applies. Order matters — regen and penetration checks run before the plain
 * `health`/`mana`/`armor` fallbacks, and every "…Health Regen" / "…Mana Regen"
 * variant collapses to one key.
 */
export function statIconKey(stat: unknown): string {
  if (typeof stat !== 'string') {
    return '';
  }
  const s = stat.toLowerCase();
  if (s.includes('health regen')) return 'health-regen';
  if (s.includes('mana regen')) return 'mana-regen';
  if (s.includes('attack damage')) return 'ad';
  if (s.includes('ability power')) return 'ap';
  if (s.includes('attack speed')) return 'as';
  if (s.includes('ability haste') || s.includes('cooldown reduction')) return 'ah';
  if (s.includes('armor penetration') || s.includes('lethality')) return 'armor-pen';
  if (s.includes('magic penetration')) return 'magic-pen';
  if (s.includes('magic resist')) return 'mr';
  if (s.includes('armor')) return 'armor';
  if (s.includes('critical strike damage')) return 'crit-damage';
  if (s.includes('critical strike') || s.includes('crit ')) return 'crit-chance';
  if (s.includes('life steal') || s.includes('lifesteal')) return 'lifesteal';
  if (s.includes('omnivamp')) return 'omnivamp';
  if (s.includes('heal and shield') || s.includes('heal and shield power')) return 'heal-shield';
  if (s.includes('move speed') || s.includes('movement speed')) return 'ms';
  if (s.includes('tenacity')) return 'tenacity';
  if (s.includes('adaptive')) return 'adaptive';
  if (s.includes('mana')) return 'mana';
  if (s.includes('health')) return 'health';
  if (s.includes('gold')) return 'gold';
  return '';
}

/** Riot `hextech-ui-icons/clock.svg`, verbatim path data. */
function ClockIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className ? `stat-icon ${className}` : 'stat-icon'}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M6.99961 13.5896C10.5342 13.5896 13.3996 10.7242 13.3996 7.18955C13.3996 3.65493 10.5342 0.789551 6.99961 0.789551C3.46499 0.789551 0.599609 3.65493 0.599609 7.18955C0.599609 10.7242 3.46499 13.5896 6.99961 13.5896ZM6.99961 11.761C9.52434 11.761 11.571 9.71428 11.571 7.18955C11.571 4.66482 9.52434 2.61812 6.99961 2.61812C4.47488 2.61812 2.42818 4.66482 2.42818 7.18955C2.42818 9.71428 4.47488 11.761 6.99961 11.761Z"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M6.08496 4.44678H6.99925L7.54783 6.64108L9.7421 7.18965V8.10393H6.99925L6.69447 7.49439L6.08496 7.18964V6.27537L6.08496 6.27536L6.08496 6.27536V4.44678Z"
      />
    </svg>
  );
}

export function StatIcon({ stat, size = 14, className }: StatIconProps) {
  if (stat.trim().toLowerCase() === 'cooldown') {
    return <ClockIcon size={size} className={className} />;
  }

  const url = STAT_ICON[statIconKey(stat)];
  if (url === undefined) {
    return null;
  }

  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className={className ? `stat-icon ${className}` : 'stat-icon'}
    />
  );
}
