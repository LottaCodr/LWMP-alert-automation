# Living Water Birthday Care

A mobile-first, internal **TypeScript** birthday-care system for **Living Water
Mega Parish – RCCG**. It holds the member details needed for pastoral birthday
care, builds a privacy-minimised daily digest, and sends it only to verified,
opted-in staff endpoints — with a delivery receipt for every message.

> **Safety status:** the system ships configured for **mock delivery**. The
> demo records and credentials are fictional. Nothing is sent to a real phone
> until the parish completes provider onboarding and deliberately sets
> `MESSAGE_MODE=live`.

---

## What it does

- **Member records** with Nigerian phone normalisation, AES-256-GCM encrypted
  phone fields, separate HMAC lookup hashes, consent records, duplicate
  warnings, archive controls and reviewed CSV import.
- **Roles** for Organisation Owner, Membership Officer, Birthday Coordinator and
  Auditor. Coordinators see only their assigned ministry groups; auditors are
  read-only.
- **Staff access** via expiring single-use invitations, a 12-character password
  policy, mandatory first-login MFA (TOTP or passkey) and recovery codes.
- **Verified, opted-in endpoints only.** A number receives nothing until it has
  proved control with an SMS code.
- A configurable **daily digest** (default 07:30 Africa/Lagos) with lead days,
  a 29 February policy, WhatsApp-first routing and SMS fallback.
- A **durable PostgreSQL outbox**: jobs are claimed with
  `FOR UPDATE SKIP LOCKED`, retried with bounded backoff and dead-lettered after
  five attempts. A failed WhatsApp callback queues exactly one idempotent SMS
  fallback.
- **Signature-verified provider webhooks** (Meta HMAC-SHA256, Termii
  HMAC-SHA512) so API acceptance is never mistaken for handset delivery.
- An **append-only audit trail** of every privileged action.

---

## Stack

| Layer     | Choice                                                                   |
| --------- | ------------------------------------------------------------------------ |
| API       | Express 5, TypeScript (strict), Zod, `express-session` on PostgreSQL     |
| Data      | PostgreSQL (`pg`), numbered SQL migrations, AES-256-GCM field encryption |
| Delivery  | Meta WhatsApp Cloud API, Termii SMS + OTP, durable outbox                |
| Auth      | bcrypt, TOTP (`otplib`), WebAuthn passkeys (`@simplewebauthn`)           |
| Front end | React 19 + Vite, no router or state library, design tokens               |
| Quality   | Vitest, type-aware ESLint, Prettier, HTTP smoke test, CI                 |

---

## Run it locally

```bash
npm ci
npm run dev:demo      # API + in-memory Postgres + seeded demo data → http://localhost:3000
npm run dev           # Vite dev server → http://localhost:5173 (proxies /api to :3000)
```

Node **20.19+**. `npm run dev:demo` needs no database server: `DATABASE_URL`
defaults to the in-memory `pg-mem` PostgreSQL and seeds fictional data.

### Demo accounts

All fictional accounts use the password `LivingWater@2026`.

| Role                 | Email                         | Can                                      |
| -------------------- | ----------------------------- | ---------------------------------------- |
| Organisation Owner   | `owner@livingwater.demo`      | Everything, including the rule and staff |
| Membership Officer   | `membership@livingwater.demo` | Members, imports, full phone numbers     |
| Birthday Coordinator | `birthdays@livingwater.demo`  | Upcoming birthdays for assigned groups   |
| Auditor              | `audit@livingwater.demo`      | Audit trail and delivery log, read-only  |

Never reuse a demo account, password or mock verification code in production.

### Against a real PostgreSQL

```bash
export DATABASE_URL='postgresql://user:password@localhost:5432/livingwater'
npm run migrate:postgres
npm run bootstrap:owner        # prints a single-use owner password
npm run dev:server
```

---

## Scripts

| Command                    | What it does                                              |
| -------------------------- | --------------------------------------------------------- |
| `npm run dev:demo`         | API with in-memory Postgres and seeded demo data          |
| `npm run dev`              | Vite dev server, proxying `/api` to the API               |
| `npm run dev:worker`       | Dedicated scheduler/delivery worker                       |
| `npm run build`            | Clean, typecheck, compile the server and build the SPA    |
| `npm start`                | Run the compiled API (serves `client/dist` if present)    |
| `npm run worker`           | Run the compiled worker                                   |
| `npm run typecheck`        | Strict TypeScript for server **and** client               |
| `npm run lint`             | Type-aware ESLint, `--max-warnings=0`                     |
| `npm run format`           | Prettier                                                  |
| `npm test`                 | Vitest: domain rules, presentation helpers, WCAG contrast |
| `npm run smoke:postgres`   | End-to-end HTTP test against the real app on pg-mem       |
| `npm run check`            | Everything above, in order — what CI runs                 |
| `npm run migrate:postgres` | Apply checksummed migrations                              |
| `npm run bootstrap:owner`  | One-time owner account creation                           |

---

## Quality gates

`npm run check` runs, in order: typecheck → lint → unit tests → smoke test.

The **smoke test** boots the actual Express app and drives it over HTTP:
CSRF rejection, sign-in, dashboard, concurrent member-code allocation, outbox
delivery, WhatsApp failure → SMS fallback, Termii webhook signature handling,
unsigned-webhook rejection, endpoint verification, staff invitation, forced TOTP
enrollment with ten recovery codes, auditor 403 on the member directory, audit
trail and health.

The **contrast tests** parse `client/src/styles/tokens.css` and recompute WCAG
2.2 AA ratios, so a palette change that drops below 4.5:1 for text or 3:1 for
input borders and focus rings fails the build.

Type errors are **fixed, not suppressed**.

---

## Deployment

Two documented paths:

| Path                                                                                | Guide                                                    | Blueprint                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| **Free tier** — SPA on Vercel Hobby, API on a Render free service, Postgres on Neon | [`docs/HOSTING.md`](docs/HOSTING.md)                     | [`render.free.yaml`](render.free.yaml)         |
| **Production** — Render web + dedicated worker + managed PostgreSQL                 | [`docs/RENDER_DEPLOYMENT.md`](docs/RENDER_DEPLOYMENT.md) | [`render.yaml`](render.yaml)                   |
| Supabase instead of Render/Neon Postgres                                            | [`docs/SUPABASE_OPTION.md`](docs/SUPABASE_OPTION.md)     | [`render.supabase.yaml`](render.supabase.yaml) |

Two facts drive the free-tier design:

1. **Render free instances cannot run background workers or cron jobs**, so the
   birthday scheduler runs in-process with `SCHEDULER_ENABLED=true`.
2. **Render's free PostgreSQL is deleted after 30 days**, so the database must
   be external (Neon's free tier does not expire).

A single Render service can also serve the built SPA — no Vercel, no CORS. See
§13 of the hosting guide.

---

## Configuration

Copy `.env.example` for local development only. Production values belong in your
platform's encrypted environment store — never in git, a frontend bundle or
chat. `server/config.ts` validates every variable at boot and **refuses to
start in production with a missing secret**, naming the variable.

| Variable                                                   | Use                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                             | PostgreSQL connection string, or `pgmem://` for the demo runtime                               |
| `SESSION_SECRET`, `FIELD_ENCRYPTION_KEY`, `PHONE_HASH_KEY` | Three distinct high-entropy secrets. Losing the encryption key makes stored numbers unreadable |
| `APP_ORIGIN`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`          | Canonical HTTPS origin and relying-party id for invitations and passkeys                       |
| `CORS_ORIGINS`                                             | Set only for split hosting; switches the session cookie to `SameSite=None`                     |
| `MESSAGE_MODE`                                             | `mock` (default) or `live`; `live` is refused at boot until every provider value exists        |
| `EMAIL_MODE`, `RESEND_API_KEY`, `INVITE_FROM_EMAIL`        | Staff invitation email; `resend` is required in production                                     |
| `SCHEDULER_ENABLED`                                        | Run the birthday cron in-process (required on Render free)                                     |
| `META_*`, `TERMII_*`                                       | Provider credentials, approved templates and webhook secrets                                   |

The Meta adapter expects an approved template with **one body variable: the
authorised birthday count**. It never places names, phone numbers, dates of
birth or a member directory in a lock-screen message.

---

## Privacy and provider guardrails

- Use the official **Meta WhatsApp Business Cloud API** through a
  parish-controlled Business Portfolio and an official parish number — never
  WhatsApp Web automation or a staff member's personal number.
- Record an auditable opt-in for each administrator endpoint, verify control of
  it with an OTP, and honour opt-out immediately.
- Use Termii's approved DND/transactional route for operational SMS and its
  native Verify Token flow for endpoint OTP. Delivery webhooks are verified with
  `X-Termii-Signature` (HMAC-SHA512); Meta callbacks with the App Secret.
- Meet the parish's NDPC obligations before loading live member data: documented
  purpose and lawful basis, privacy notice, retention schedule, processor
  agreements, access review, incident procedure, staff training, and a DPIA.
- Test backup restoration. A backup that has never been restored is not yet a
  trusted backup.

---

## Repository layout

```text
server/
  app.ts index.ts worker.ts scheduler.ts   Entry points and middleware order
  config.ts logger.ts errors.ts types.ts   Validated config, logging, contracts
  database-pg.ts notification-pg.ts auth-pg.ts
  domain/        Pure rules: calendar, phone, masking, messaging, csv-import
  services/      Use cases: members, dashboard, endpoints, imports, passkeys, webhooks
  http/          Middleware: session, cors, guards, rate limits, logging, errors
  routes/        One module per resource
client/src/
  api/ lib/ hooks/ components/ app/ features/ styles/
scripts/         migrate-postgres, bootstrap-owner, smoke-test-postgres
migrations/      Numbered, checksummed SQL
docs/            ARCHITECTURE.md, HOSTING.md, provider-specific runbooks
```

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); contribution rules
in [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Notes

- The **SQLite runtime has been removed**. PostgreSQL is the only runtime;
  `scripts/import-sqlite-to-postgres.ts` remains for a one-time migration of an
  existing `.db` file and is the only code that needs the optional
  `better-sqlite3` dependency.
- `pg-mem` is a **test runtime**. It has no persistent session table and no real
  concurrency; it is not a substitute for managed PostgreSQL.
- Passkeys require HTTPS in production.
