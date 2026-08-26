# Implementation Plan: visual-assets

## Overview

This plan is ordered by what the visitor sees soonest, not by what is architecturally tidiest. Champion icons and the profile icon need no new Riot data — the identifiers are already in the `ProfileReport` — so they land first and turn the page from a spreadsheet into something recognisable within one wave of the Static_Data_Provider existing. Item images need Match-V5 fields the application does not currently capture, so they follow.

The plan opens with a live verification task. The Static_Data_Provider is specified as a frontend component on the assumption that Data_Dragon serves its metadata files with permissive CORS headers; if it does not, the provider moves behind the backend and its interface changes shape. Building it first and discovering that afterwards would mean rewriting it rather than placing it correctly once.

Two things are built as pure, total functions before anything renders them: `itemBuildOf` on the backend and the Static_Data_Provider's accessors on the frontend. Both are property-tested in isolation. The positional item logic in particular is the kind that looks right in every hand-written example and is wrong in the general case, so it is pinned by a generator before a component depends on it.

## Tasks

- [ ] 1. Confirm the CDN contract and expose the pinned version
  - [x] 1.1 Verify Data Dragon's metadata contract
    - Fetch `champion.json` and `item.json` for a current version and record whether `Access-Control-Allow-Origin: *` is served; the Static_Data_Provider is specified as a frontend component on this assumption and moves behind the backend if it fails
    - Record the `champion.json` entry shape that maps a Champion_Key to its display name, and confirm `MonkeyKing` resolves to `Wukong`
    - Confirm `img/profileicon/0.png` exists, since the design rests on `0` being a valid icon rather than a sentinel
    - Write the findings into design.md, replacing the "must be confirmed" note with the observed behavior
    - _Requirements: 4.4, 2.2, 1.3_

  - [x] 1.2 Add the pinned version to configuration and expose it
    - Add `DDRAGON_VERSION` to backend config with no "latest" fallback, so a missing value fails fast rather than resolving to a moving alias
    - Implement `GET /api/static-data` returning `{ dataDragonVersion }`; no Riot call, no cache entry, no rate-limit reservation
    - _Requirements: 4.1, 4.2, 4.3_

- [ ] 2. Build the Static Data Provider
  - [x] 2.1 Implement the provider and its accessors
    - Seed from `GET /api/static-data`, then fetch `champion.json` and `item.json` once and retain for at least 24 hours
    - Implement `championDisplayName`, `championIconUrl`, `profileIconUrl`, `itemIconUrl`, `itemDisplayName`, and `ready`
    - Make every accessor total: a URL or `null`, a name or a documented fallback — never an empty string, never a URL containing `undefined`, never a throw, before or after metadata loads
    - Return `null` from `itemIconUrl` for identifier `0`, and treat `profileIconUrl(0)` as a real icon rather than as absent
    - Do not route any request through the Rate_Limit_Manager, and do not proxy images through the backend
    - _Requirements: 1.3, 1.4, 2.4, 4.4, 4.5, 4.6, 5.3, 5.4_

  - [ ]* 2.2 Write property test for URL totality
    - **Property 2: Asset URL resolution is total**
    - **Validates: Requirements 4.1, 4.2, 5.3, 5.4**
    - Include the empty string, `null`, `0`, negatives, and identifiers absent from the metadata, and run the property both before and after the provider is ready
    - Also generate **prototype-chain keys** (`constructor`, `toString`, `__proto__`, `hasOwnProperty`). A plain-object map resolves these through `Object.prototype`, and a review of task 2.1 found they produced a URL ending in the literal `undefined`; the hand-written sweep in `provider.test.ts` omitted them and missed it
    - `fast-check` is a **backend** devDependency only — add it to the frontend workspace before writing this

  - [ ]* 2.3 Write property test for display name fallback
    - **Property 4: Champion display names fall back without ever being empty**
    - **Validates: Requirements 1.3, 1.4, 6.2**

  - [x] 2.4 Implement the Asset Placeholder
    - Render at the same dimensions as the asset it replaces, so a missing image never reflows the page
    - Give it a text alternative describing what could not be loaded
    - _Requirements: 5.1, 6.4_

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Render champion icons and the profile icon
  - [x] 4.1 Make `profileIconId` nullable end to end
    - Remove the `finiteOrZero` coercion in the orchestrator so an absent value is `null` rather than `0`; `0` is a valid icon and must stay distinguishable from missing
    - Mirror the nullable type in the frontend contract
    - _Requirements: 2.2_

  - [x] 4.2 Implement `ChampionIcon` and `ProfileIcon`
    - Render the icon when the provider resolves a URL and the Asset_Placeholder when it does not, at identical dimensions in both cases
    - Swap to the Asset_Placeholder on the image's `error` event as well. This is the ONLY mechanism Requirement 2.4 has: the provider fetches `champion.json` and `item.json` but never `profileicon.json`, so it cannot tell a valid icon id from one added after the pinned release, and an unresolvable profile icon reaches the page as a live URL that 404s
    - Render the Champion_Display_Name beside the icon, falling back to the raw Champion_Key
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1, 2.3, 2.4, 5.1_

  - [x] 4.3 Place the icons in the report
    - Champion icons in the top-champions list, in every match history row, and on the Enemy_Laner in every row where one was identified
    - The profile icon adjacent to the analyzed player's Riot ID
    - Keep every icon accompanied by its name in text rather than replacing the name with the image, so no information is carried by an image alone
    - _Requirements: 1.1, 1.2, 2.1, 6.5_

  - [ ]* 4.4 Write property test for text alternatives
    - **Property 3: Every rendered asset has a non-empty text alternative**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

  - [ ]* 4.5 Write unit tests for icon rendering
    - Placeholder for an empty and for an unknown Champion_Key (1.4, 1.5); `profileIconId` of `0` renders a real icon while `null` renders a placeholder, and the two are distinguishable (2.2, 2.3); placeholder dimensions equal the asset they replace (5.1)
    - _Requirements: 1.4, 1.5, 2.2, 2.3, 5.1_

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Capture item builds on the backend
  - [x] 6.1 Implement `itemBuildOf`
    - Total and never throwing, matching the existing mapping module's contract: a malformed, absent or non-numeric slot becomes `0`
    - Preserve zeros rather than filtering them, so slot positions stay stable
    - Return items 0–5 as a fixed-length tuple and slot 6 as a separate `trinket` field, so the trinket distinction is not re-derived at each call site
    - _Requirements: 3.1, 3.5, 3.6_

  - [x] 6.2 Attach builds to both sides of the matchup
    - Add `build` to the analyzed player's match summary, and to `OpponentSummary` using the same participant row `opponentOf` already selects — never a different one
    - Leave `opponentOf`'s selection logic untouched; it already returns nothing when no lane could be determined
    - _Requirements: 3.1, 3.2, 3.9_

  - [ ]* 6.3 Write property test for opponent build provenance
    - **Property 5: An opponent's build always comes from the opponent's own participant row**
    - **Validates: Requirements 3.2, 3.7, 3.9**

  - [ ]* 6.4 Write unit tests for `itemBuildOf`
    - Malformed, absent, non-numeric and out-of-range slot values; a full build; a build with interleaved empty slots
    - _Requirements: 3.1_

- [ ] 7. Render item builds in the match history
  - [x] 7.1 Implement `ItemBuildRow`
    - Render six item positions and one trinket position in slot order, with the trinket visually distinct
    - Render an empty slot for identifier `0` without constructing an image source or issuing a request
    - Return nothing at all for a null build, so a match with no Enemy_Laner renders no opposing slots
    - _Requirements: 3.3, 3.5, 3.6, 3.7_

  - [ ]* 7.2 Write property test for positional slot rendering
    - **Property 1: Item slot rendering is positional and never requests an empty slot**
    - **Validates: Requirements 3.3, 3.5, 3.6**
    - Generate every arrangement of zeros and non-zeros across the seven slots, including interleaved empties, so the position-shifting bug cannot hide behind trailing-empty examples

  - [x] 7.3 Place both builds in each match history row
    - The analyzed player's build, and the Enemy_Laner's build where one was identified, laid out so the two are readable as a comparison
    - Label the display as the final build; do not describe it as a purchase order
    - _Requirements: 3.3, 3.4, 3.7, 3.8_

  - [ ]* 7.4 Write unit tests for build rendering
    - Trinket distinct from items 0–5 (3.5), no opposing build when `opponent` is null (3.7), no image request for a zero slot asserted by counting constructed sources (3.6), final-build labelling (3.8), every item image carrying its name as a text alternative (6.5)
    - _Requirements: 3.5, 3.6, 3.7, 3.8, 6.5_

- [ ] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Resilience, compliance and documentation
  - [x] 9.1 Verify and harden the degraded path
    - Confirm the report renders in full with every image a placeholder when `GET /api/static-data` fails and when the metadata fetch fails, without blanking or blocking
    - Ensure no image element is rendered whose source could not be constructed
    - _Requirements: 5.2, 5.3_

  - [x] 9.2 Apply the Riot compliance template and content policy
    - Render every page displaying assets through the existing `RiotDataPage` wrapper (`frontend/src/compliance/RiotDataPage.tsx`) so attribution and the no-advertising default apply without being re-implemented
    - Serve assets from Riot's distribution unmodified; do not rehost, alter or re-brand them
    - If a Content-Security-Policy is present or later added, allow `ddragon.leagueoflegends.com` as an image and connect source
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 9.3 Write integration test for a mixed report
    - A report containing a match with a full six-item build plus trinket, a match with three empty slots interleaved among items, a match with no Enemy_Laner, and a match whose `championName` is empty — asserting correct slot positions, an absent opposing build, and placeholders where expected
    - _Requirements: 1.5, 3.3, 3.6, 3.7_

  - [x] 9.4 Update the README
    - Document `GET /api/static-data`, the `DDRAGON_VERSION` config value and how to bump it on a patch, and the fact that assets are hot-linked from Riot's CDN rather than proxied or rehosted
    - _Requirements: 4.1, 4.3, 4.6, 7.3_

- [ ] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster delivery; they are not implemented by the coding agent by default.
- **Waves 0–4 deliver visible value on their own.** Champion icons and the profile icon need no new Riot data, so the site stops looking like a spreadsheet after task 4.3 — before any backend match work begins. If this needs to ship in pieces, that is the seam.
- Task 1.1 is deliberately first and is not optional. The Static_Data_Provider's location — frontend or behind the backend — depends on whether Data_Dragon serves permissive CORS on its metadata files, and task 2.1 encodes that choice.
- **`0` is a valid profile icon, and `0` is an empty item slot.** The same literal means opposite things in the two contexts, which is why task 4.1 removes the `finiteOrZero` coercion on `profileIconId` while task 6.1 deliberately preserves zeros in item slots. Do not unify these.
- **Never filter empty item slots.** Filtering shifts every later item left, which renders a plausible but wrong build. Property 1 exists because this bug is invisible in any example whose empty slots are trailing — the common case, and the one a hand-written test would use.
- `opponentOf` in `backend/src/orchestrator/mapping.ts` already identifies the Enemy_Laner and already returns nothing when no lane could be determined. Task 6.2 attaches items to the row it selects; it must not re-implement or adjust the selection.
- Match-V5's participant record reports the **final inventory at game end**, not a purchase sequence. Requirement 3.8 requires the UI to say so. A real purchase timeline needs Match-V5's timeline endpoint and is specified by the `item-timeline` feature, which depends on this one for its item images, its component classification, and the `ItemBuild` its reconciliation check compares against.
- Property tests use `fast-check` with a minimum of 100 runs each, tagged `// Feature: visual-assets, Property {n}: {property text}`.
- Several existing property tests in `backend/src/` guard coverage with a bare `expect(count).toBeGreaterThan(0)` and no pinned `examples`. Do not copy that pattern: Property 1 in particular must pin an interleaved-empty arrangement explicitly, or a generator run could pass without ever producing one.
- This spec's nullable `profileIconId` and the `lookup-pipeline-fixes` spec's nullable `profileIconId` are the same type change made for different reasons — `0` being a real icon here, Summoner-V4 being demoted to enrichment there. Whichever lands first satisfies the other; both reasons must survive in the code comment, or a later change could look free to revert it.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.4", "6.1"] },
    { "id": 2, "tasks": ["2.1", "4.1", "6.2"] },
    { "id": 3, "tasks": ["2.2", "2.3", "4.2", "6.3", "6.4"] },
    { "id": 4, "tasks": ["4.3", "7.1"] },
    { "id": 5, "tasks": ["4.4", "4.5", "7.2", "7.3"] },
    { "id": 6, "tasks": ["7.4", "9.1", "9.2"] },
    { "id": 7, "tasks": ["9.3", "9.4"] }
  ]
}
```
