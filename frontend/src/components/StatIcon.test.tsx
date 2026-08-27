import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatIcon, statIconKey } from './StatIcon';

describe('statIconKey', () => {
  it('maps stat names, sharing keys where Riot/the wiki share an icon', () => {
    expect(statIconKey('Attack Damage')).toBe('ad');
    expect(statIconKey('Lethality')).toBe('armor-pen');
    expect(statIconKey('35% Armor Penetration')).toBe('armor-pen');
    expect(statIconKey('Ability Haste')).toBe('ah');
    expect(statIconKey('Cooldown Reduction')).toBe('ah');
    expect(statIconKey('Critical Strike Chance')).toBe('crit-chance');
    expect(statIconKey('Critical Strike Damage')).toBe('crit-damage');
  });

  it('collapses every regen variant to one key', () => {
    expect(statIconKey('Base Health Regen')).toBe('health-regen');
    expect(statIconKey('Health Regen per 5 seconds')).toBe('health-regen');
    expect(statIconKey('Base Mana Regen')).toBe('mana-regen');
    expect(statIconKey('Mana Regen per 5 seconds')).toBe('mana-regen');
  });

  it('returns empty for an unmapped stat', () => {
    expect(statIconKey('Slow Resist')).toBe('');
    expect(statIconKey(undefined)).toBe('');
  });
});

describe('StatIcon', () => {
  it('inlines the Riot clock glyph for the Cooldown stat', () => {
    const { container } = render(<StatIcon stat="Cooldown" size={16} />);
    const svg = container.querySelector('svg.stat-icon');
    expect(svg).not.toBeNull();
    expect(svg?.querySelectorAll('path')).toHaveLength(2);
  });

  it('renders a bundled image for a mapped stat', () => {
    const { container } = render(<StatIcon stat="Life Steal" />);
    const img = container.querySelector('img.stat-icon');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBeTruthy();
  });

  it('renders nothing for an unmapped stat', () => {
    const { container } = render(<StatIcon stat="Slow Resist" />);
    expect(container.firstChild).toBeNull();
  });
});
