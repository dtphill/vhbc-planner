# Group invitations, catalogue management and BGG link details

Version 1.3.0 adds the following controls while retaining the compact four-column catalogue.

## Members

- A reusable group invitation opens the existing name, email and password form. No BGG account is requested and no collection is imported. Membership is granted by possession of the private group link, not by an unverified email address. Registration uses the existing account and password system.
- On an existing game, **I can teach** opens a compact player-count selection. Saving preserves existing ownership and pitch. **Teacher wanted** appears when no active member has offered to teach that game (it is not an attendance-specific flag).
- Games are still added individually with an explicit ownership or teaching offer and selected player counts. There is no bulk import.
- Pasting a valid BGG game-page link retrieves its primary title, thumbnail and minimum/maximum player range via the item endpoint, not the search endpoint. A deliberately edited title is not overwritten. The Add button still requires an explicit action.
- Counts outside BGG's listed range are muted, never disabled. Selected counts remain authoritative for allocation, including house rules and expansions. The existing 2–12-player controls are unchanged.
- Last-known metadata and thumbnail URLs are stored separately from the expiring search cache. Cached details remain usable when BGG lookup is unavailable; image delivery still depends on BGG's image CDN. New games can be entered manually if the first lookup is unavailable.

## Organisers

- **Available games → Delete game** hides a game from the active catalogue and allocation. It clears affected priority picks, removes that game's upcoming reservations, and resets upcoming table recommendations. It does not delete completed play history or saved ratings/offers.
- **Organise → Invite the group → Deleted games → Restore game** restores a deleted game. Preferences and copy/teaching offers remain; cleared priority picks and table reservations are not automatically reinstated.
- **Organise → Invite the group → Create group invitation**, then **Copy group link**, produces one link to share within the group. Anyone who receives it can join as an ordinary member. Replace or disable it to prevent further registrations using the old link. Existing accounts are unaffected. Individual email-bound invitations remain available.

## Security and rollout

Apply `migrations/0004_community_tools.sql` before deploying this version. No existing catalogue entries are removed and no group link is enabled by the migration. Preserve DB, APP_URL, BETTER_AUTH_SECRET and BGG_TOKEN.

The group token is random and HMAC-authenticated; its active nonce is server-side and revocable. A valid group token is exchanged for an internal short-lived, single-use member invitation. Admin status is never accepted from registration input. The reusable link stays in the URL fragment and is cleared by the registration UI. Write routes enforce same-origin requests, and admin routes enforce role checks. Metadata queries use a fixed BGG endpoint, bounded reads, manual redirect handling, an allowlisted image host and request limits. Secrets are never returned or logged.

Source entry: `src/worker-community.mjs`. The active-catalogue adapter scopes the existing catalogue reads and validation queries to non-archived games; authentication and play-history queries are unchanged. The community wrapper adds new routes without changing the allocation algorithm or authentication mechanism.

Focused checks: `node --test tests/community-tools.test.mjs` (Node 22.16+). Full `npm test` also needs the project's pinned dependencies. Offline browser fixtures exercise teaching, deletion visibility, manual-link title filling, player-count guidance, group-link registration routing and mobile layout. Production member login should be checked separately; tests do not create real member accounts or delete real games.
