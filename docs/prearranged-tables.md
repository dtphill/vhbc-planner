# Pre-arranged tables from Next meeting

The secondary **Already arranged a game?** option is collapsed by default, below the new-game review area. It is available to signed-in members and organisers on Next meeting; attendance and rating games remain the primary actions.

Opening it loads a current meeting snapshot. Choose an available game, agreed attendees, an attending teacher offering the exact player count, and a free copy supplied by an attendee. Confirm that everyone has agreed, then select **Save pre-arranged table**.

Ordinary members must be among the players they reserve. Organisers can arrange a table for others. All players must be attending and have explicitly rated the game Want or Will play; saved player-count restrictions still apply. Existing player/copy reservations cannot be reused. A copy owner may play at another table.

Saving appends only the new reservation and clears the obsolete recommendation, without automatically assigning everyone else. The organiser still generates and confirms the full meeting plan and manages removal of reservations. Confirmed, completed and removed meetings are protected. No preferences, attendance, play history, scoring or tie-break settings are changed.

The new routes are `/api/prearranged/options` (GET) and `/api/prearranged/reserve` (POST). They reuse the existing session and active-membership checks through bootstrap. Writes require the same origin, explicit agreement, the exact current meeting date and revision. Audit and conditional update share a D1 transaction so stale or concurrent submissions cannot replace other reservations. Client-supplied role and arbitrary extra fields are not trusted. No database migration, external service, secret or package is needed.

Build entry: `src/worker-prearranged.mjs`. Preserve existing Cloudflare bindings. The health response adds `prearrangedTables: "1.3.1"` without removing the existing version and tie-break metadata.

Focused tests: `node --test tests/prearranged.test.mjs` (17 passing checks). Offline Chromium fixtures verify default collapse, ordinary-member form submission, error feedback, navigation, and desktop/mobile layout. These checks do not create or modify any real group reservations.
