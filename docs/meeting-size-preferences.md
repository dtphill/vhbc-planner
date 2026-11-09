# Optional table-size preferences — 1.6.0

After marking **I'm coming** on **Next meeting**, members see **Table size this meeting**: **No preference**, **2 players**, **3–4 players**, **5+ players**. They may select more than one group. Choices save automatically. All groups or no groups means No preference. It is deliberately a small secondary control below attendance, not another required sign-up step.

Preferences belong to the member and meeting date. They do not copy to another meeting, change standing game ratings, change the priority pick, or change an ownership/teaching offer's exact player counts. The size is the number actually seated, including the teacher, not BGG's advertised range. Members who have not selected a preference are neutral.

## Allocation order

Seat as many willing players as possible; maximise eligible priority boosts; maximise the number of selected table-size preferences matched; then apply the existing personal game-rotation, accommodation, Want/Will and meeting-specific tie-break rules. Each person contributes at most one size match. A member may still receive a different size to seat everyone or honour eligible priorities. Pass, unrated games, exact teacher/member counts, missing copies and overlapping reservations remain hard constraints. Pre-arranged tables stay fixed.

Size is a real preference rather than a final cosmetic tie-break. It can therefore outweigh an unplayed alternative or an ordinary Want-versus-Will difference once attendance and eligible priorities are tied. No preference leaves the previous scoring and stable draw unchanged. This does not guarantee everyone's chosen size.

The solver retains the original per-game traversal for neutral inputs. With size preferences it uses an exact per-game partition DP indexed by copies used, so two preferred two-player tables can be selected instead of one legal four-player table when two copies and teachers exist. Size cannot create extra copies. Score metadata adds `tableSizeMatches` and tables include their members' size outcomes.

## Private tests

The same allocator and inputs are used in the private single-meeting test. Expand **Table-size preferences in this test** for the matched count and each seated member's preference/actual size. Multi-meeting simulations read dated preferences from the existing read-only snapshot: the next-meeting choice applies to that date, not automatically to every subsequent dummy meeting. Later dates default to No preference unless an actual preference was already saved for that exact date. Dummy history and all test outputs remain in memory, never recorded or published.

## Persistence and safety

`migrations/0005_meeting_size_preferences.sql` adds one separate table and index. It does not alter existing attendance, preferences, reservations or history. Apply it before the Worker update. Source entry: `src/worker-size-preferences.mjs`; preserve all current bindings.

`POST /api/meeting-size-preferences` requires the normal active-member session, same origin, an explicit current date, coming attendance and a bounded validated JSON body. Members can save only their own preference. Confirmed/completed/removed meetings reject changes. A change invalidates only that meeting's open draft recommendation and increments its revision; fixed reservations stay. A no-op does not reset a plan. Atomic conditional updates with a unique change token prevent stale requests from overwriting a newer plan. No new emails, credentials or external services are introduced.

A narrow SQL adapter adds the preference field to the existing live and private planning queries without replacing authentication, weakening the SELECT-only private guard or adding writes to tests. Controls use the existing initial bootstrap and app-refresh event; no duplicate startup request or persistent browser preference cache is introduced.

## Verification

Run `node --test tests/table-size.test.mjs tests/table-size-api.test.mjs`. Portable solver checks include an independent exhaustive oracle over 120 small mixed scenarios; runtime checks additionally compare 200 neutral scenarios with the preceding deployed allocator. Database tests use SQLite and the actual migration/queries, including isolation by member/date, stale revisions, permissions, invalid bodies and protection of confirmed meetings. Browser fixture checks cover save, multiple choices, failure preservation, neutral reset, stable rendering, disabled confirmed controls and desktop/mobile width. These fixtures are not a signed-in production session.
