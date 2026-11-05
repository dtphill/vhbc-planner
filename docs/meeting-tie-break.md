# Meeting-specific final tie-break

The organiser still selects **Recommend tables**. Seating, priority/fairness,
and Want-versus-Will scores are unchanged and remain the first three criteria.
Only completely equal optimum arrangements are resolved differently.

## Member-facing behaviour

- The final tie-break has a fixed draw for each meeting date.
- Recommending again with unchanged preferences, attendance, teaching/copy
  offers, history and reservations produces exactly the same result.
- Another meeting date has another draw. It can still choose the same outcome;
  this is not a guaranteed rotation or a guarantee of equal long-term outcomes.
- Changing the actual inputs can legitimately change the recommendation.
- Agreed tables remain fixed. Existing saved/confirmed plans and play history
  are not rewritten by this release. A newly generated plan uses the new rule.

## Implementation

`savePlan` supplies the server-selected meeting ID as `tieBreakSeed`. The client
cannot submit or reroll it. The returned `tieBreak` metadata is saved with the
plan and records the method and seed, so the outcome can be reproduced.

`meeting-seeded-order-v1` uses domain-separated SHA-256 ranks of the seed and
stable game/member/copy IDs. Those ranks order the exact solver's traversal of
otherwise equal alternatives. The solver still maximises the same seating,
fairness and desire scores; the draw never changes their values or precedence.
It also varies tied member groupings rather than only the order of game titles.
Names, input-array order, the current time, request number and caller do not
change the draw. IDs remain the collision fallback only. Standalone calls with
no seed preserve the legacy ordering for compatibility.

This is a seeded tie-breaking order, **not uniform sampling of every possible
complete table arrangement**. No claim of equal probability for all complete
schedules or a guaranteed monthly alternation is made. It removes the fixed
ID-order preference across meeting dates without changing the allocation goals.
No runtime random source, new secret, package or database migration is required.

## Verification

Run:

```sh
node --test tests/allocation.test.mjs tests/calendar.test.mjs tests/tie-break.test.mjs
```

All 33 checks passed locally. The tests cover reproducibility, shuffled inputs,
variation across meetings, tied seat assignments and same-game partitions,
priority and ordinary preference precedence, pre-arranged tables, exact counts,
copy availability, and 12 attendees with 24 interchangeable games. Across 100
mixed scenarios and six seeds each, objective scores match the legacy optimum.
The test set does not alter production attendance or existing plans.
