# Private consecutive meeting simulation — 1.4.3

On **Organise → Private algorithm test → Open private test**, use **Simulate several meetings**, select 2–12 dummy meetings (default 6), then **Run dummy meetings**. The existing single-meeting private test is unchanged.

Each run reads one snapshot of the next meeting's current attendees and real history. It deep-copies the input, calls the unchanged live allocator, appends a completed dummy result to the copy of each member's history, and calculates the next round using that history. It uses the same ratings, exact player counts, teaching/copy offers and attendees throughout. The first round respects existing reservations. Later rounds have no pre-arranged tables. Later dates are hypothetical fourth Sundays in successive months, not the real future meeting schedule. Their dates supply the usual meeting-specific tie-break seed.

The default **Keep the same pick (live behaviour)** retains each current priority even after playing it. The waiting bonus resets after that play; the base priority value remains, so the game can be chosen again. **Clear it for remaining dummy meetings** is an explicitly hypothetical alternative: it clears only fulfilled priorities in the simulation and does not invent a replacement. No real member's pick is changed.

The progression grid shows each member's assignment, priority fulfilment, waiting bonus before and after each dummy play, first fulfilment and total priority plays. Expand a round for tables and **Bonus changes and priority eligibility**, including accommodation bonuses and the total value of fulfilling the current priority. Bonus explanations mirror the live allocator and regression checks reconcile them with the actual solver's fairness score; they do not make allocation decisions.

A round with unseated players or validation warnings stops the series. Its partial result is shown but is not added to the simulated history. An empty meeting generates no plays. This prevents treating an invalid plan as a completed meeting.

## Isolation and security

`POST /api/admin/planner-series` requires the same origin and delegates authentication and current active-organiser authorisation to the existing protected private page using an internal HEAD request. It then reads the same snapshot via the existing SELECT-only D1 guard. The private-page authentication repair remains intact. Only the meeting count and a boolean clear-fulfilled option are accepted; client-supplied participants, history, roles, dates and tie-break seeds are rejected. Bodies are capped at 1 KiB.

Simulation history lives only in the current request and the returned private page response. No plans, meetings, history, audit results, sessions, ratings, reservations or notifications are written. No result is placed in localStorage, sessionStorage or shared caches. **Clear simulation** cancels the page request and discards displayed results. Every rerun starts from real history rather than the previous simulation. The source snapshot, current allocation rules and all normal routes are unchanged. Responses are private/no-store; there is no publish button.

Build entry: `src/worker-series.mjs`. No migration, secret, dependency or billing change is required.

## Verification

`node --test tests/planner-series.test.mjs` runs the portable checks in `tests/planner-series.checks.mjs` against the real allocator. The same checks can run in an isolated Cloudflare diagnostic Worker with synthetic fixtures and no production bindings. They cover history progression, repeatability, first-round equivalence, waiting/accommodation caps, clearing/retaining priorities, year transitions, reservations, stopping incomplete plans, input validation, private-only rendering and SELECT-only repeated requests. Authentication delegates to the existing private route; these tests do not substitute a new authentication implementation.
