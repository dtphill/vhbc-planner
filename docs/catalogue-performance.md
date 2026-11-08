# Catalogue search, interest totals and loading — 1.4.0

**Include expansions** sits next to the title search and defaults off. Enabling it sends `expansions=1`, requests both BGG board-game types, and uses a separate search cache. Expansion results are labelled. Existing group/manual catalogue matches remain findable even during BGG outages. Pasted links continue to accept expansions independently of this checkbox. No collection import is introduced.

Each game displays **Want N · Will play N**. These are the current standing preferences of all active group members, not only next-meeting attendees. A priority pick already counts as Want; it is not counted twice. Pass, unrated, disabled members and archived games are excluded. No individual preference list is disclosed.

Saved thumbnail addresses travel with the initial authenticated catalogue response. Only public BGG IDs and allowlisted image URLs are stored in browser localStorage, for up to seven days and 300 entries. Image bytes use normal browser HTTP caching under BGG's response headers; this is not an offline image archive. Clearing site data/private browsing can remove the cache. Images visible first are eager-loaded; other images are lazy-loaded.

The thumbnail route reads cache rows and last-known metadata in two bulk queries. Known artwork does not wait for BGG; stale entries can refresh through `waitUntil`. Only genuinely missing artwork blocks on an upstream request. Cache writes occur together in a D1 batch only after an upstream fetch, not every time someone views saved covers. Auth, catalogue-ID validation, response limits, URL allowlists and manual redirect protection remain in place.

Duplicate initial bootstrap requests are removed. Rating and priority saves return authoritative aggregate totals and update the current view after a successful server response; they no longer reload the full catalogue and admin schedule. Failed saves do not change the displayed preference. Undo still refreshes state. Teaching/deletion refresh the app rather than reload the document. Organiser schedules load when needed. Personal API responses remain `no-store`; no authentication or preference responses are placed in a shared or persistent browser cache.

Build entry: `src/worker-catalogue.mjs`. Checked string adapters update the existing client assets without replacing their account/meeting code. Existing features, allocations, history, meeting tie-breaks, secrets and data are preserved. No database migration or new dependency is required.

Verification: `node --test tests/catalogue-enhancements.test.mjs` passes 19 focused checks. Ten additional inline Chromium fixture checks cover the checkbox, counts, saving/failure behaviour, one initial bootstrap, no reload after ratings, browser URL storage and mobile overflow. These are mocked tests, not proof of live signed-in BGG availability. The full pinned-dependency suite was not run in the restricted build environment.
