# Stat icons

These are champion-stat glyphs (Attack Damage, Lethality, Critical Strike, Life
Steal, the regens, …) rendered in the asset hover tooltips by
`src/components/StatIcon.tsx`.

## Source

The **League of Legends Wiki** champion-stat icon set
(`Category:Champion_stat_assets`) — Riot's in-game stat glyphs, mirrored by the
wiki. Downloaded from `https://wiki.leagueoflegends.com/en-us/images/<Name>.png`
(patch 16.17.1). The **colored** variant is used where the wiki has one
(`<Name>_colored_icon.png`); `crit-damage` has no colored variant and uses the
base icon; `adaptive-force` uses `Adaptive_icon_2.png`.

Each icon was **normalized** for consistent visual weight: cropped to its opaque
bounding box, scaled so the larger dimension is 40 px, centred on a 48×48
transparent canvas, and palette-quantized (~1 KB each, all inlined into the
bundle by Vite). The wiki source canvases ranged from 20 px to 96 px with wildly
different internal padding, so rendering them raw made some (attack speed,
omnivamp) look tiny next to the others.

Riot Games publishes an individual asset for only ~10 stats (the rune stat-mod
set on Data Dragon / Community Dragon). Every other stat exists only inside
game-client sprite atlases with no public coordinate map, so this set was chosen
for **complete, visually consistent coverage**. "Cooldown" is not in this set —
`StatIcon` inlines Riot's own client clock glyph for it.

## Mapping (kebab file name ← wiki file)

| File | Wiki source | Used for |
|---|---|---|
| attack-damage | Attack_damage_colored_icon | Attack Damage |
| ability-power | Ability_power_colored_icon | Ability Power |
| attack-speed | Attack_speed_colored_icon | Attack Speed |
| ability-haste | Ability_haste_colored_icon | Ability Haste, Cooldown Reduction |
| armor | Armor_colored_icon | Armor |
| armor-pen | Armor_penetration_colored_icon | Armor Penetration, Lethality |
| magic-resist | Magic_resistance_colored_icon | Magic Resist |
| magic-pen | Magic_penetration_colored_icon | Magic Penetration |
| crit-chance | Critical_strike_chance_colored_icon | Critical Strike Chance |
| crit-damage | Critical_strike_damage_icon *(no colored variant)* | Critical Strike Damage |
| life-steal | Life_steal_colored_icon | Life Steal |
| omnivamp | Omnivamp_colored_icon | Omnivamp |
| heal-shield-power | Heal_and_shield_power_colored_icon | Heal and Shield Power |
| health | Health_colored_icon | Health |
| health-regen | Health_regeneration_colored_icon | all Health Regen variants |
| mana | Mana_colored_icon | Mana |
| mana-regen | Mana_regeneration_colored_icon | all Mana Regen variants |
| move-speed | Movement_speed_colored_icon | Move Speed |
| tenacity | Tenacity_colored_icon | Tenacity |
| adaptive-force | Adaptive_Force_icon *(no colored variant)* | Adaptive Force |
| gold | Gold_colored_icon | Gold Per 10 |

League of Legends and all related assets are property of Riot Games, used here
under Riot's Legal Jibber Jabber policy for non-commercial fan projects.
