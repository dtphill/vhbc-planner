# Private algorithm test — 1.4.1

Open **Organise → Private algorithm test → Open private test**, then **Run private test**.
The separate `/admin/planner-test` page is restricted to active organisers. Ordinary members cannot access the page or its API, even by entering the address directly.

Each run reads a consistent snapshot of the next meeting's current attendees, active games, preferences, teaching/copy offers, exact player-count restrictions, recorded history and existing reservations. It calls the existing allocation module with the same meeting-date tie-break seed. No alternate scoring or AI service is used. The live API's current 12-attendee limit is retained.

The private result shows tables, assigned players and their Want/Will/priority status, teacher and copy owner, priority picks fulfilled, unseated players, solver warnings, all three comparison scores and the meeting tie-break. Expand **Scoring and attendee details** for the per-attendee view. A possible priority table need not coexist with every other table. Rerun to pick up changed attendance or preferences; identical inputs produce identical assignments, not a fresh draw.

## No publication or recording

The test does not save a plan, reserve tables, confirm a meeting, record plays, change ratings or attendance, create audit results or enqueue email. It does not replace an existing public proposal or confirmed plan. There is no publish button. Results exist only in the returned private response and the organiser's current page; reloading the page discards them. They are not written to localStorage, sessionStorage or an application database.

The implementation reads the normal fourth-Sunday/manual meeting schedule without calling `ensureMeeting`, so it cannot create a meeting row. It respects removed dates and existing reservations. The result remains private even when the real meeting is already confirmed.

## Security and isolation

`POST /api/admin/planner-test` accepts only an empty JSON object, requires the site's origin, and checks the real signed session plus current administrator role. Client-supplied dates, attendees, roles, seeds and overrides are rejected. Responses and the protected page are `private, no-store`. No tokens, email addresses or raw history rows are returned.

`private-session.mjs` calls the existing authentication library's server API with session refresh and cookie cache disabled, avoiding the HTTP authentication rate-limit write path. A SELECT-only D1 adapter is applied to both session validation and the snapshot queries; unexpected writes fail closed. Expired sessions requiring cleanup are denied and must sign in again through the normal site. The eight snapshot reads execute in a single D1 read batch. No BGG request or new service is involved.

Build entry: `src/worker-private-planner.mjs`. Keep all existing bindings. This release needs no migration, dependency, secret or account changes. The deployed module entry wraps the existing catalogue entry; the bundled existing authentication factory is exposed only as an internal module export, never as an HTTP endpoint. All existing routes and the scheduled handler are preserved.

## Checks

`node --test tests/private-planner.test.mjs tests/allocation.test.mjs tests/calendar.test.mjs` passes 43 tests, including 23 private-planner checks. Repeated runs are compared against whole-database snapshots; existing plans, revisions, reservations, history, audit rows and outbox rows stay identical. Other checks cover administrator denial, request limits, archive/attendance handling, cancellation/manual dates, exact counts, copy/teacher availability, deterministic parity with the live solver and blocked mutation attempts.

Nine offline Chromium fixture checks passed for manual execution, endpoint isolation, results, scoring detail, repeated runs, mobile layout, escaped text and organiser-only launcher behaviour. Fixtures contain no real member data. These checks do not establish a signed-in production session; production deployment and public access denial are checked separately. The full pinned-dependency build suite is not claimed as run in this network-restricted environment.
