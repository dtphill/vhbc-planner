# Meeting management

Administrators manage dates in **Organise → Meetings**. The normal fourth-Sunday schedule and 10 am start remain the default.

- Add a meeting for today or any future date. Dates must be real calendar dates and cannot duplicate an existing meeting.
- Remove a scheduled meeting after confirming the action. Removal is reversible for today and future dates. A removed fourth Sunday is excluded from automatic scheduling, so refreshes do not recreate it.
- Restore a removed future meeting from **Removed meetings**. Attendance is retained, but old table plans and reservations are cleared so they can be checked again.
- Completed meetings cannot be removed; their play history continues to inform preference balancing. Older unrecorded meetings can be removed separately.

The app shows the earliest active meeting, including manually added dates. Date-targeted writes carry `X-VHBC-Meeting` so a stale browser cannot silently record attendance against a newly selected meeting after cancellation. Admin permissions and same-origin checks are enforced on the server.

## Deployment

Apply `migrations/0003_meeting_management.sql` before deploying this source. It adds `meeting_exclusions`; no existing meetings, attendance or history are deleted. Keep the existing `DB`, `APP_URL`, `BETTER_AUTH_SECRET` and `BGG_TOKEN` bindings.

## Focused checks

With Node.js 22.16 or newer, run:

```sh
node --test tests/meetings.test.mjs tests/calendar.test.mjs tests/allocation.test.mjs
```

The full Worker integration test also applies the meeting-management migration. `npm test` requires the project's pinned dependencies and builds the Worker first.
