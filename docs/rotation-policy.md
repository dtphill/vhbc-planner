# Automatic game rotation — 1.5.0

This replaces the scoring order described in earlier release notes. It applies to the live allocator, the single private test and the multi-meeting simulator. It changes no ratings, selected picks, reservations or completed results.

## Selection order

1. Seat the greatest number of willing attendees at legal tables.
2. Maximise eligible priority boosts: base 6 plus up to 2 qualifying waiting points.
3. Prefer games absent from each assigned player's retained history, then games played longest ago by that player.
4. Recognise recent Will-play compromises when assigning a Want game, using the existing capped accommodation credit.
5. Prefer more Want assignments to Will-play assignments.
6. Resolve exact ties with the existing meeting-specific draw.

Separating accommodation from priority matters: otherwise a few compromise credits can keep a recently played game winning over every unplayed alternative. Variety can therefore select a Will-play game instead of a recently repeated Want game; it never treats Pass or an unrated game as consent.

## Priority rest

After a person actually plays their selected game, that game's base and waiting boost rest until that person has completed four other plays. The pick stays selected and still counts as Want. The fifth subsequent allocation can apply its boost again. Playing the same game sooner restarts its rest period. During rest it earns no waiting credit. On returning to eligibility, only subsequently missed eligible opportunities can earn waiting credit.

A recent play counts even if it was pre-arranged or the person chose that priority later. Dates passing or meetings not attended do not age the rest. A member who has not played the game still receives their own eligible priority boost: this is not a group-wide ban. Pre-arranging a willing table remains an explicit override; the automatic solver may also repeat a game when necessary to seat people.

## Rotation score and history scope

For each assigned player, a game absent from their supplied last 24 valid recorded plays scores 25; otherwise it scores the number of that person's subsequent plays since the most recent play (0–23). Add these contributions across the arrangement. This is a preference after seating and eligible priorities, not a hard prohibition or a guaranteed round-robin. It does not infer lifetime play counts or import BGG play history. Reserved plays count for recency, but do not earn fairness bonuses. Fixed tables contribute a constant rotation score and cannot be changed by the draw.

The score object adds `priority`, `rotation` and `accommodation`. `priorityAndFairness` is retained as a backwards-compatible diagnostic sum of priority and accommodation, not as a comparison stage. Live and simulation explanations both use `rotation-policy.mjs` rather than independently duplicating history formulas. Private reports show the separate scores and before/after priority-rest counts.

## Persistence and rollout

Nothing is written during private tests. Each series starts again from the real history and carries dummy results forward only in memory. The normal workflow needs actual completed plays recorded before later live recommendations can rotate. Existing proposals and confirmed tables are not rewritten. No migration, secret, new service or billing change is required.

## Validation

A read-only, anonymised copy of the six current attendees' preferences and offers reproduced Angola in all 12 rounds under the previous policy (3 distinct games overall). Under this policy the same diagnostic produced Angola in 3 of 12 rounds and 17 distinct games overall, with all six people seated every round. Database IDs were anonymised, so exact tie outcomes may differ from the site's draw. No member-level fixture or credentials are included in this repository.

The prepared policy passed 35 focused local checks, including an independent exhaustive oracle over 120 small scenarios and two seeds each. The release also checks the actual modules in the Cloudflare runtime before activation. The full dependency suite is not claimed as run.
