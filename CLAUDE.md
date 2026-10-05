# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome Manifest V3 extension (side panel) with utilities for boardgamearena.com (BGA):
- **Red thumbs tab** – lists players you have red-thumbed and who have red-thumbed you; lets you remove/give red thumbs.
- **Bulk tab** – search a game, then red-thumb every player above/below a rating threshold (ELO or Arena) from that game's ranking.

Plain JavaScript, no build step, no dependencies, no tests or linter. To run: `chrome://extensions` → Developer mode → "Load unpacked" → this folder; reload the extension there after edits. The panel only works while a logged-in boardgamearena.com tab is open.

## Architecture

- `manifest.json` – permissions `sidePanel`, `scripting`, `storage`; host permissions for `boardgamearena.com`.
- `background.js` – only makes the toolbar icon open the side panel.
- `sidepanel.html` – UI (inline CSS, two tabs: `#tab-thumbs`, `#tab-bulk`).
- `sidepanel.js` – all logic.

### Talking to BGA
Almost everything runs **inside the BGA tab** via `chrome.scripting.executeScript({ world: "MAIN" })`, because it needs the page's globals and session:
- `globalUserInfos` – source of `red_thumbs_given` / `red_thumbs_taken` and `game_list` (game search).
- `window.bgaConfig.requestToken` – sent as the `X-Request-Token` header on BGA requests.

Helpers: `pageRequest` (generic same-origin fetch in the tab), `pageJson` (parses BGA's `{status: "1", data}` envelope and throws otherwise), `changeReputationInPage` (calls `/table/table/changeReputation.html?player=…&value=…`, value `0` removes, and also patches `globalUserInfos.red_thumbs_given` locally). The exception is `fetchProfile`, which fetches `/player?id=` directly from the panel and scrapes name/avatar; profiles are cached in `chrome.storage.local` (`profileCache`, 1-day TTL).

### Bulk red-thumb
- Rankings come from POST `/gamepanel/gamepanel/getRanking.html` (`game`, `start`, `mode`), sorted high → low.
- The `RATINGS` table defines per-rating-type `mode`, the row `field`, `parse`, and conversion between user input and the compared value. ELO: BGA's `ranking` is user-visible ELO + 1300. Arena: the `arena` value is `"<prefix>.<rating>"`; only the part after the dot is the rating.
- "Below" mode uses `findBelowThresholdStart` (gallop from `SKIP_AHEAD_START`, then binary search on pages) to skip the top of the ranking; failed probes count as "below" so players are never skipped.
- Requests are rate-limited (`RANK_DELAY`, `THUMB_DELAY`, `FAILURE_BACKOFF`) and aborted after `MAX_CONSECUTIVE_FAILURES`; `bulkStopRequested` is checked between steps. Keep these throttles when adding new request loops.
