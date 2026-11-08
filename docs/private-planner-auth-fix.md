# Private planner sign-in repair — 1.4.2

The private page incorrectly told an already signed-in organiser to sign in. The normal planner accepted the same session.

## Cause

The private route wraps the database in a SELECT-only adapter. Better Auth 1.7.15 inspects the database schema before validating a session. An INTEGER primary key in the existing `group_join_links` table causes its schema inspector to issue `PRAGMA index_list('group_join_links')`. That is a read-only metadata query, but the guard rejected it. The authentication exception was then incorrectly classified as a missing login.

## Fix

The guard translates only the exact, single-quoted `PRAGMA index_list(...)` and `PRAGMA index_info(...)` forms into the equivalent `SELECT * FROM pragma_index_list(...)` and `SELECT * FROM pragma_index_info(...)` queries. It still rejects writes, multi-statement SQL, arbitrary PRAGMAs, settings changes, unverified batch statements and other database operations. Session signature/expiry checks and current active-administrator verification are unchanged. The private test still cannot publish, reserve, record, notify or alter meeting data.

Authentication infrastructure errors now return 503 with a distinct message rather than falsely asserting that the user is signed out. Missing/invalid sessions still receive 401 and non-administrators receive 403. No cookie, password, role or account change is required for an existing valid organiser session.

## Verification

Reproduced with the actually deployed authentication bundle in a temporary Cloudflare Worker with synthetic users, signed cookies and schema metadata, and **no production bindings or secrets**. The old guard accepted the fixture without the INTEGER-key table but rejected it after that table was added; the corrected guard accepts both.

Nineteen runtime checks passed: organiser page access, member/disabled-member rejection, missing/tampered/revoked-session rejection, private API success without writes, member API denial, cross-origin denial, infrastructure-error handling, and nine mutation/unsafe-SQL rejection cases. The corresponding regression scenarios are retained in `tests/private-auth-regression.test.mjs` and use the real authentication library rather than a mocked session validator. The full dependency test suite was not run during this repair.

Only `private-planner.mjs` changes in the live application. No production database writes, migration, new binding or new secret are involved. Temporary diagnostic resources are removed after verification.
