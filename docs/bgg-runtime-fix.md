# BGG fetch repair — 1.2.1

Search, cover metadata, and the badge proxy all used `redirect: "error"`. Cloudflare Workers rejects this value when constructing the Request, before contacting the upstream. Node's fetch and the old mocked tests accepted it, which concealed the production failure.

All three calls now use `redirect: "manual"`. Their existing non-success status handling rejects every redirect response; no automatic following is introduced, and the BGG token stays on the fixed BGG API endpoint. No account, invitation, preference, meeting, player-count or database-schema changes are included.

Reference: https://developers.cloudflare.com/workers/runtime-apis/request/

## Verification

- The repaired deployment compiled in Cloudflare and was activated as version 1.2.1.
- A live Browser Rendering request to the site's badge endpoint changed from HTTP 503 JSON to HTTP 200 image/png, 1472 by 432 pixels.
- 37 focused media, allocation and calendar tests passed locally. These include redirect rejection and credential-isolation tests. The media tests use fixtures, not the production BGG token.
- Updated the search tests to require manual redirects and added a redirect-rejection test. The full dependency-based search/integration suite was not rerun in this environment.
- Full signed-in live search and thumbnail retrieval still require verification through a member session. No temporary public diagnostic endpoint or authentication bypass was installed.
