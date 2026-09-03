# Architecture

Living Water Birthday Care is a single TypeScript codebase that ships two
artifacts: an **Express 5 API** backed by PostgreSQL, and a **React 19 SPA**
built by Vite. Both are compiled and type-checked by the same `npm run check`.

---

## 1. Design invariants

These are the properties the code is organised to protect. When a change
threatens one, the change is wrong, not the invariant.

1. **A phone number is never stored in plaintext.** It is encrypted with
   AES-256-GCM (`FIELD_ENCRYPTION_KEY`) and indexed by an HMAC
   (`PHONE_HASH_KEY`) so duplicates can be detected without decrypting.
2. **A phone number is never shown to someone who may not see it.** Masking is
   applied where the DTO is built on the server (`memberDto`, `endpointDto`),
   never in the browser.
3. **Nothing is delivered to an endpoint that is not both verified and opted
   in.** Verification is a six-digit code sent to the number itself.
4. **At most one digest per person per rule per day**, guaranteed by a
   `notification_key` unique constraint rather than by application logic.
5. **Delivery is durable.** A notification is written together with an outbox job
   in one transaction; the job is what actually talks to the provider.
6. **Every privileged action is audited** with actor, action, entity and summary.
7. **Production refuses to boot with a missing secret.** `server/config.ts`
   validates the environment with Zod at import time and names the offending
   variable. No fallback secret is committed anywhere: outside production the
   in-memory runtime gets fresh per-process material, and any real database
   refuses to start without the three secrets.

---

## 2. Repository layout

```
server/
  domain/          Pure business rules. No I/O, fully unit-tested.
    calendar.ts      Lagos dates, Feb-29 policy, day arithmetic
    phone.ts         Nigerian normalisation, E.164, masking
    masking.ts       Redaction helpers
    messaging.ts     Digest copy, channel wording
    csv-import.ts    Row validation for reviewed imports
    __tests__/       Vitest suites for each of the above
  database-pg.ts   Typed pg access + pg-mem adapter, encryption, DTO mappers
  notification-pg.ts  Rule evaluation, outbox, provider dispatch, webhooks
  auth-pg.ts       Passwords, TOTP, recovery codes, invitations
  services/        Use cases that combine database + domain rules
    members.ts dashboard.ts endpoints.ts imports.ts passkeys.ts webhooks.ts
  http/            Cross-cutting Express middleware
    session.ts cors.ts guards.ts rate-limits.ts request-log.ts error-handler.ts
  routes/          One module per resource; thin, declarative, no business logic
  config.ts logger.ts errors.ts types.ts
  app.ts           Middleware order + router mounts
  index.ts         HTTP entry point (optional in-process scheduler)
  worker.ts        Dedicated worker entry point
  scheduler.ts     The tick both entry points share

client/src/
  api/             Typed endpoint wrappers + the fetch client (CSRF, errors)
  lib/             Pure helpers: formatting, password assessment, status maps
  components/      Reusable UI primitives (Button, Modal, Toasts, Field, …)
  hooks/           useAsync, useTheme
  app/             Router, session context, application shell
  features/        One folder per screen (auth, dashboard, members, …)
  styles/          Design tokens + layered stylesheets (tokens → base →
                   components → layout) and the WCAG contrast tests

scripts/           migrate-postgres, bootstrap-owner, smoke-test-postgres,
                   import-sqlite-to-postgres (one-time migration off the
                   retired SQLite runtime)
migrations/        Numbered, checksummed SQL
docs/              This file, HOSTING.md, provider-specific notes
```

**Layering rule:** `routes → services → database/domain`. A route validates
input and shapes the response; a service owns the use case and the audit entry;
`domain/` owns rules that can be tested without a database. Nothing in
`domain/` may import from `database-pg.ts` or `http/`.

---

## 3. Request lifecycle

Order matters and is fixed in `server/app.ts`:

```
helmet (CSP in production)
  → request logger (logs req.originalUrl without the query string)
  → CORS (origin allowlist, credentials)
  → express.json  (700 kB; keeps the raw body for HMAC verification)
  → express.urlencoded (80 kB)
  → express-session (connect-pg-simple on user_sessions)
  → /api CSRF double-submit  (exempt: provider webhooks)
  → /api rate limit
  → routers
  → /api 404 handler
  → static client/dist + SPA fallback
  → error handler (always last)
```

Express 5 rejects a promise returned from a handler, so **no `try/catch` or
`asyncHandler` wrapper is needed** — handlers throw, the error handler answers.

Every API error has the same envelope:

```json
{ "error": { "code": "MEMBER_NOT_FOUND", "message": "Member not found." } }
```

`requestId` is added outside production. Non-`/api` paths get plain text so a
browser navigating to a broken URL sees a readable message.

**Router mounts:** `/api/dashboard`, `/api/auth`, `/api/invitations`,
`/api/members`, `/api/birthdays`, `/api/notifications`, `/api/settings`,
`/api/endpoints`, `/api/staff`, `/api/imports`, `/api/audit`, `/api/webhooks`,
`/api/health`.

---

## 4. Data model

| Table                    | Purpose                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `users`                  | Staff accounts, role, group scope, MFA state, active flag                            |
| `staff_invitations`      | Single-use, expiring invitation tokens (stored hashed)                               |
| `mfa_recovery_codes`     | Hashed one-time recovery codes                                                       |
| `passkeys`               | WebAuthn credentials, counters, transports                                           |
| `user_sessions`          | Server-side session store (connect-pg-simple)                                        |
| `members`                | Member records: encrypted phone, hashed phone, birth month/day/year, status, consent |
| `consent_records`        | Lawful basis and source for each consent event                                       |
| `admin_endpoints`        | Staff delivery endpoints, encrypted phone, priority, verification state              |
| `endpoint_verifications` | Pending verification codes (hashed), attempts, expiry                                |
| `notification_rules`     | The parish rule: time, lead days, channel, fallback, Feb-29 policy                   |
| `notifications`          | One row per message per recipient, with provider ids and status                      |
| `outbox_jobs`            | Durable delivery jobs (`FOR UPDATE SKIP LOCKED`, bounded retries)                    |
| `provider_events`        | Raw provider webhook events                                                          |
| `audit_events`           | Append-only audit trail                                                              |
| `app_settings`           | Key/value parish profile                                                             |

Migrations are applied by `scripts/migrate-postgres.ts`, which records a
checksum per file: re-running skips applied migrations and **fails** if an
applied migration was edited afterwards. Change history is added as a new file.

`DATABASE_URL=pgmem://` swaps in the in-memory PostgreSQL compatibility layer
(`pg-mem`) so the whole stack — including the smoke test — runs without a
database server.

---

## 5. Security model

**Authentication.** Password (bcrypt) → mandatory second factor (TOTP or
passkey). Sessions are server-side, `httpOnly`, 8 hours, `SameSite=Lax`
(`None; Secure` when `CORS_ORIGINS` is configured for split hosting). The
session id is regenerated on login and on MFA success. A pre-MFA session lives
15 minutes and can only reach MFA endpoints.

**CSRF.** Double-submit: `GET /api/auth/csrf` issues a token bound to the
session; unsafe methods must echo it in `x-csrf-token`. Compared with
`timingSafeEqual` after a length check.

**RBAC.**

| Capability                                   | Owner | Membership Officer | Birthday Coordinator | Auditor |
| -------------------------------------------- | :---: | :----------------: | :------------------: | :-----: |
| Member directory (full phone)                |  ✅   |         ✅         |          ❌          |   ❌    |
| Upcoming birthdays (scoped to `group_scope`) |  ✅   |         ✅         |          ✅          |   ❌    |
| Create/edit/archive members, CSV import      |  ✅   |         ✅         |          ❌          |   ❌    |
| Notification rule, run-now                   |  ✅   |         ❌         |          ❌          |   ❌    |
| Own endpoints, test alerts                   |  ✅   |         ✅         |          ✅          |   ❌    |
| Staff management                             |  ✅   |         ❌         |          ❌          |   ❌    |
| Audit trail                                  |  ✅   |         ❌         |          ❌          |   ✅    |

Enforced by `requireRoles` / `canViewMember` / `canRevealPhone` in
`server/http/guards.ts` **and** mirrored in the client's `capabilitiesFor` so
the UI does not offer actions that would fail. The server is the authority; the
client mirror is a courtesy.

**Rate limits** (`server/http/rate-limits.ts`): global API limiter, plus
stricter limits on login, MFA and endpoint verification.

**Webhooks.** Meta: `hub.verify_token` for subscription, then HMAC-SHA256 over
the **raw body** (`x-hub-signature-256`). Termii: HMAC-SHA512 over the raw body
(`x-termii-signature`). Both reject with 401 on mismatch.

**Delivery is opt-in by default off.** `MESSAGE_MODE=mock` never contacts a
provider, so a misconfigured deployment cannot message real people.

---

## 6. Delivery pipeline

```
node-cron tick (every minute, Africa/Lagos)
  └─ scheduledTick()
       ├─ rule enabled AND Lagos clock == rule.alertTime AND not already run this minute
       │    └─ runBirthdayNotifications()
       │         • resolve today's birthdays (± lead days, Feb-29 policy, role scope)
       │         • for each staff endpoint: verified + opted-in + enabled
       │         • INSERT notification + outbox job in one transaction
       │           (unique notification_key ⇒ idempotent)
       └─ processOutboxJobs()
            • SELECT … FOR UPDATE SKIP LOCKED
            • dispatch via Meta / Termii (or mock)
            • success → status update, delivered/read on webhook
            • failure → attempts++, exponential backoff, dead_letter after 5

provider webhook
  └─ applyProviderStatus()  (signature verified first)
       └─ WhatsApp failure + eligible SMS endpoint ⇒ one idempotent SMS fallback
```

Because the tick is per-minute and the key is per-day, a restart, a cold start
or two processes cannot double-send.

---

## 7. Frontend architecture

- **No router or state library.** `app/router.ts` is ~90 lines over the History
  API; `app/session.tsx` mirrors `GET /api/auth/me`; `hooks/useAsync` covers
  loading / success / error / refreshing with request cancellation.
- **Every data surface implements four states**: skeleton loading (rows that
  match real row height so nothing jumps), populated, empty (distinguishing
  "no data yet" from "no results for these filters", the latter offering a
  clear-filters action), and error (message + Retry).
- **Design tokens only.** Colours, spacing, radii and motion live in
  `client/src/styles/tokens.css`; components never hard-code a colour. Light and
  dark themes are both token sets, selectable manually or from the OS.
- **Accessibility is tested, not asserted.** `styles/__tests__/tokens.test.ts`
  recomputes WCAG 2.2 contrast ratios from the stylesheet and fails the build
  below 4.5:1 for text and 3:1 for input borders and focus rings. Focus is
  always visible, dialogs trap and restore focus, toasts announce via
  `aria-live` without stealing focus, and there is a skip link.
- **The API client is the only place that knows about CSRF, the API origin and
  the error envelope** (`client/src/api/client.ts`), so `VITE_API_BASE_URL`
  supports split hosting without touching a single component.

---

## 8. Configuration

`server/config.ts` is the single source of truth. It reads `process.env`,
validates with Zod and exports a frozen object. Adding a variable means adding
it there (and to `.env.example`) — nothing reads `process.env` directly
elsewhere.

Notable switches:

| Variable                                          | Effect                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`                                    | `postgresql://…`, or `pgmem://` for the in-memory runtime              |
| `SCHEDULER_ENABLED`                               | Run the birthday cron inside the web process (required on Render free) |
| `MESSAGE_MODE`                                    | `mock` (default) or `live`                                             |
| `EMAIL_MODE`                                      | `log` or `resend`                                                      |
| `CORS_ORIGINS`                                    | Comma-separated allowlist; setting it enables cross-origin cookies     |
| `SEED_DEMO_DATA`                                  | Seeds fictional demo users/members (development only)                  |
| `APP_ORIGIN`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID` | Passkey ceremonies and invitation links                                |

---

## 9. Testing strategy

| Layer               | Command                             | What it covers                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain units        | `npm test`                          | Calendar/Lagos rules, Feb-29 policy, phone normalisation and masking, digest copy, CSV row validation                                                                                                                                                                                                                                              |
| Presentation units  | `npm test`                          | Date/number formatting, password assessment, role capabilities, status vocabulary                                                                                                                                                                                                                                                                  |
| Design-system units | `npm test`                          | WCAG contrast ratios parsed straight out of `tokens.css`                                                                                                                                                                                                                                                                                           |
| End-to-end          | `npm run smoke:postgres`            | Boots the real Express app on pg-mem and drives it over HTTP: CSRF rejection, login, dashboard, concurrent member-code allocation, outbox delivery, WhatsApp-failure → SMS fallback, Termii webhook signature, unsigned-webhook rejection, endpoint verification, invitation, forced TOTP with 10 recovery codes, auditor 403, audit trail, health |
| Static              | `npm run typecheck`, `npm run lint` | Strict TypeScript in both projects; type-aware ESLint (floating promises, unsafe `any`, promise rejection reasons)                                                                                                                                                                                                                                 |

`npm run check` runs all of them in order and is what CI runs.

---

## 10. Adding a feature

**A new endpoint:**

1. Add DTOs to `server/types.ts` and mirror them in `client/src/api/types.ts`.
2. Put the rule in `server/domain/` if it is pure, and unit-test it.
3. Put the use case in `server/services/`, including its `audit(...)` call.
4. Add the route in `server/routes/`, validate with Zod, mount in `app.ts`.
5. Add the typed wrapper in `client/src/api/index.ts`.
6. Build the screen under `client/src/features/<name>/`, with all four states.
7. `npm run check`.

**A migration:** add `migrations/00N_name.sql`. Never edit an applied file —
the checksum guard will reject the deploy.

---

## 11. Known constraints

- **One scheduler instance.** The outbox makes a second worker safe, but
  duplicate rule evaluation is waste. On Render free you cannot run a worker at
  all, hence `SCHEDULER_ENABLED=true`.
- **`pg-mem` is a test runtime**, not a substitute for PostgreSQL. It has no
  persistent session table (MemoryStore is used) and no real concurrency.
- **The SQLite runtime has been removed.** `scripts/import-sqlite-to-postgres.ts`
  remains for one-time migration of an existing `.db` file and is the only code
  that needs the optional `better-sqlite3` dependency.
- **Client DTOs are hand-mirrored** from `server/types.ts` (the two projects use
  different module resolutions). A drift shows up as a client type error.
