# Victorian Historical Boardgaming Collective

A private monthly game planner for the Collective. Members keep their game preferences, confirm attendance and receive a proposed table. The organiser can reserve agreed tables, generate the remaining allocations, confirm the plan and record what was actually played.

**Application:** https://vhbc.dtpgames.com  
**Meeting:** fourth Sunday of each month, from 10 am, using `Australia/Melbourne` dates. This means the fourth Sunday, not necessarily the last Sunday.  
**Automatic planning:** up to 12 confirmed attendees, with one main game per person.

## Using the app

### Members

1. Open the organiser's private invitation, register with the invited email address and choose a password of 12–128 characters.
2. Categorise games as **Want**, **Will play** or **Pass**. Unrated games are not treated as consent.
3. Star one game as **My current priority pick**. This can be a first play or a replay. Choosing a new priority moves the star; the previous game's Want rating remains.
4. Confirm **I'm coming** for each meeting. Saved ratings carry forward, so there is no monthly catalogue to rate again.
5. Check the confirmed table and any teaching or copy commitment. Update attendance or preferences if circumstances change.

The priority stays selected until changed or cleared. Playing it fulfils that meeting's request and resets its waiting bonus; it does not remove the star.

### Adding games and offers

- Search for the title and select the correct BGG entry, or add the title and optional BGG page link manually.
- Record whether you own a copy and whether you can teach. A new catalogue entry needs a copy or teaching offer; allocation needs both available.
- Explicitly choose every player count you accept, including yourself when playing. Choices are discrete: **2 and 4 does not include 3**. There are no BGG-derived count defaults.
- An offer's accepted counts also restrict that member when someone else teaches. Edit the offer if those choices change.
- Add an optional short pitch. Existing BGG IDs reuse the catalogue entry rather than creating duplicate voting entries.

Full BGG search requires a server-side `BGG_TOKEN`. Existing-catalogue search and manual entry remain usable without it. Search does not import BGG player-count recommendations into allocation rules.

### Organiser

1. Create private member invitations in the organiser view and share each with its intended recipient. Invitations expire after 14 days.
2. Add any pre-arranged tables with the agreed players, designated teacher and copy owner.
3. Generate a plan. Resolve unmatched people and invalid reservations before confirming it.
4. Confirm the tables. Optional email delivery can notify eligible members when configured.
5. On or after the meeting, record the tables only if they match what actually happened. Earlier saved meetings can also be reviewed and recorded.

Attendance, preference, priority or offer/count changes reopen the current plan. Recording an earlier meeting also reopens the current future plan because its fairness history has changed. The organiser must regenerate and reconfirm; previously confirmed arrangements are not silently treated as current.

Pre-arranged reservations survive reopening. If a reservation becomes invalid, correct or remove it before confirming a new plan. A private password-reset link can be generated in the organiser view; it expires after 30 minutes.

## Allocation rules

The deterministic solver in `src/allocation.mjs` considers complete combinations of tables, not simply the most popular titles.

- Everyone at a table must have an explicit Want or Will play rating and accept its exact count. A stale priority never overrides Pass or an unrated entry.
- The designated teacher must be one of the players and have offered that exact count.
- A copy must come from a confirmed attendee. Its owner may lend it while playing elsewhere. Each copy offer supports only one simultaneous table.
- A person appears once. Multiple tables of the same game need distinct copies and eligible teachers.
- Valid fixed tables reserve people and copies first. Invalid or conflicting reservations require correction.
- Plans maximise seated people first, then priority and bounded historical fairness, then current desire. Ties are deterministic.

Fairness uses completed plays, not proposed allocations. It considers four recent non-fixed plays, with capped recognition of Will play assignments and unmet priorities that were explicitly recorded as feasible. Fixed tables earn no accommodation or waiting credit, although actually playing the priority fulfils it. Absence earns no credit.

Feasibility means that at least one valid table could be formed under the recorded constraints; it does not mean all preferred tables could coexist. The algorithm cannot create willing opponents, a teacher or a missing copy. Solver comments describe the exact score and history contract.

## Architecture and source

| Location | Purpose |
| --- | --- |
| `public/` | Plain HTML, CSS and browser JavaScript |
| `src/worker.mjs` | Cloudflare Worker entry point and bundled asset serving |
| `src/api.mjs` | Membership, preferences, meetings, organiser actions and scheduled work |
| `src/auth.mjs` | Better Auth 1.7.15 configuration and optional email delivery |
| `src/allocation.mjs` | Pure table-allocation solver |
| `src/calendar.mjs` | Melbourne calendar and fourth-Sunday recurrence |
| `src/bgg.mjs` | Server-side BGG search, parsing and cache |
| `migrations/` | Better Auth and application D1 schema |
| `scripts/build.mjs` | Bundles the Worker and frontend; writes a build hash |
| `scripts/generate-auth-schema.mjs` | Generates the Better Auth schema |
| `tests/` | Authentication, API, calendar, BGG and allocation checks |
| `wrangler.jsonc` | Domain, bindings, database identity and schedule |

The application uses Cloudflare D1 through the `DB` binding. Its database is named `vhbc-planner`; the configured database ID is in `wrangler.jsonc`. It requires no OpenAI API key or AI agent service.

## Local development

Use Node.js 24 and npm. Install the locked dependency versions:

```sh
npm ci
```

Create `.dev.vars` for a new checkout. The following command generates a local authentication secret and refuses to overwrite an existing file:

```sh
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync(".dev.vars", "APP_URL=http://localhost:8787\nBETTER_AUTH_SECRET=" + randomBytes(32).toString("hex") + "\n", {flag:"wx", mode:0o600})'
```

Then initialise the local database, run the checks and start development:

```sh
npm run db:local
npm test
npm run dev
```

`npm test` builds first, then runs the Node test suite. `npm run dev` uses local D1 state and `.dev.vars`. Local accounts and data are separate from production; a fresh local database still needs a deliberately provisioned invitation.

The frontend is embedded in the Worker bundle, so frontend changes require a rebuild. `npm run build` produces `dist/worker.mjs` and `dist/build.json`. `node_modules`, local database state, `.dev.vars`, `.env` files and generated `dist` output are ignored by Git.

## Production configuration

| Name | Configuration |
| --- | --- |
| `APP_URL` | Canonical origin, currently `https://vhbc.dtpgames.com`; must match the browser origin |
| `BETTER_AUTH_SECRET` | Required strong production secret; distinct from local development |
| `DB` | D1 binding to the configured `vhbc-planner` database |
| `BGG_TOKEN` | Optional secret enabling full BGG search |
| `MAIL_FROM` | Verified sender identity; required for either email provider |
| `RESEND_API_KEY` | Optional secret for Resend email delivery |
| `EMAIL` | Optional native Cloudflare email-sending binding, used instead of Resend when present |

Store secret values in Cloudflare's secret configuration, not `wrangler.jsonc`, source files, command arguments or Git. Authentication uses invited email/password accounts and server-side sessions. The initial organiser is provisioned by a private invitation during deployment; there is no public signup or first-visitor-admin mechanism. Keep invitation and recovery links private.

### Optional email

Email is not configured in the initial setup, and setup sent no messages. Accounts, organiser invitations and private reset links work without email delivery.

To enable delivery, configure either `RESEND_API_KEY` plus `MAIL_FROM`, or the native `EMAIL` binding plus `MAIL_FROM`. Complete the chosen provider's sender/domain verification first. Native Cloudflare sending also requires its account setup and a Workers Paid account. Adding credentials alone does not verify a sending domain.

Meeting notifications require both a verified email address and member opt-in. The scheduled Worker runs daily at **21:00 UTC** and creates an RSVP reminder when the meeting is seven Melbourne calendar days away. It also processes the notification outbox. Confirmation messages are checked against the meeting's current locked revision so superseded plans are not sent from the queue.

## Deployment

The initial release was verified on the existing Workers Free plan with live password hash/verification and a synthetic twelve-person allocation check. No paid-plan upgrade was made. All 39 tests passed locally, including the Workers runtime integration tests.

The source is maintained in the private [dtphill/vhbc-planner repository](https://github.com/dtphill/vhbc-planner). The production application runs at [vhbc.dtpgames.com](https://vhbc.dtpgames.com/) on Cloudflare Workers with the configured D1 database. The initial deployment used the connected Cloudflare tools. GitHub stores the source; deployment is a separate step using the commands below after authenticating Wrangler. No automatic deployment pipeline is configured.

For subsequent deployment from an authorised local checkout:

```sh
npx wrangler login
npm ci
npm test
npm run db:remote
npm run deploy
```

Check the selected Cloudflare account, custom domain and database identity before applying remote migrations. `npm run deploy` builds the bundled Worker and deploys the configuration in `wrangler.jsonc`; it does not replace or seed the database. Production secrets and any optional email binding must already be configured.

After deployment, check `/api/health`, sign-in, a saved preference, attendance and organiser planning. Avoid creating trial completed-play history in the production group: it influences future allocations.

## Operations and maintenance

- **Data:** back up D1 before schema or authentication upgrades. Database exports contain personal information and authentication data; keep them private and outside source control. A Worker rollback does not roll back D1.
- **Migrations:** apply committed migrations with `db:local` or `db:remote`. `npm run schema` regenerates the initial Better Auth SQL from the installed version. Do not rewrite an already-applied migration to upgrade a live database; review and add an appropriate new migration.
- **Upgrades:** keep dependency and lockfile changes together. Run `npm test`, review schema changes and verify local sign-in before deployment.
- **Account recovery:** use the organiser's private recovery-link flow when email is unavailable. Share links directly with the intended member; do not post them in a public forum.
- **Privacy:** group views show display names and participation information. Account emails and authentication records are not public catalogue data. Invitation and administrative endpoints require the relevant access checks. This is not a claim of independent security certification.
- **Logs:** use Cloudflare Worker observability for failures. Do not add passwords, invitation/reset tokens, secrets or database dumps to logs or issues.

### Common problems

| Symptom | Check |
| --- | --- |
| BGG search finds only existing games | Configure `BGG_TOKEN`, or use manual entry |
| A game cannot form a table | Willing players, exact individual counts, assigned teacher, attending copy owner and existing reservations |
| A confirmed plan reopens | Attendance/preferences/offers changed, or an earlier meeting was recorded; regenerate and confirm |
| A pre-arranged table is rejected | Every named member must attend and accept the game/count; teacher and copy must be available |
| No reminder or confirmation email | Provider configuration, verified sender/domain, verified member email and opt-in |
| A request is rejected for its origin | `APP_URL` must match the actual origin, including the local port |
| Wrangler cannot deploy | Authenticate to the intended account; the connected deployment does not log the local CLI in |
