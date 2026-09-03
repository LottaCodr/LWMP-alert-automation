# Living Water Birthday Care

A mobile-first, internal **TypeScript/TSX** birthday-care system for **Living Water Mega Parish – RCCG**. It keeps the member information needed for pastoral birthday care, builds a privacy-minimised daily digest, and sends that digest only to verified, opted-in staff endpoints.

> **Current safety status:** the repository is functional and has a PostgreSQL runtime, but it is deliberately configured for **mock message delivery**. The included records and demo credentials are fictional. It will not send WhatsApp or SMS until the parish completes provider onboarding and deliberately changes `MESSAGE_MODE` to `live`.

## What is implemented

- Member records with Nigerian-phone normalisation, AES-256-GCM encrypted phone fields, separate HMAC lookup hashes, consent/basis records, duplicate warning, archive controls, audit events, and CSV review/import.
- Roles for Organisation Owner, Membership Officer, Birthday Coordinator, and Auditor; Birthday Coordinators see only their assigned ministry groups.
- Staff invitation emails, strong password policy, mandatory first-login MFA, TOTP enrollment, recovery codes, and passkey/WebAuthn support over HTTPS.
- Verified and opted-in administrator WhatsApp/SMS endpoints; no alert is sent to an unverified endpoint.
- A configurable **07:30 Africa/Lagos** daily digest, February 29 policy, WhatsApp-first routing, SMS fallback, delivery history, provider webhooks, and idempotent notification keys.
- A durable PostgreSQL outbox: delivery jobs are claimed safely with `FOR UPDATE SKIP LOCKED`, retried with bounded exponential backoff, and dead-lettered after five failed attempts. A failed WhatsApp callback queues one idempotent SMS fallback where an eligible SMS endpoint exists.
- Direct provider adapters for Meta WhatsApp Cloud API, Termii transactional/DND SMS, Termii-native endpoint OTP, and Resend invitations. Browser code never receives provider credentials or database/encryption secrets.
- A Render Blueprint (`render.yaml`) with one web service, one dedicated delivery worker, managed PostgreSQL, a database readiness health check, and shared encrypted configuration.

## Runtime choices

| Context | Commands | Storage / scheduling |
|---|---|---|
| Local demonstration | `npm start` with no `DATABASE_URL` | SQLite; seeded fictional demo data; scheduler is on unless `SCHEDULER_ENABLED=false` |
| PostgreSQL application | `DATABASE_URL=… npm start` | PostgreSQL web API; keep `SCHEDULER_ENABLED=false` when using the dedicated worker |
| PostgreSQL worker | `DATABASE_URL=… npm run worker` | Evaluates the daily Africa/Lagos rule and processes delivery jobs |
| Production | Render Blueprint | Managed PostgreSQL, PostgreSQL-backed sessions, web API plus exactly one worker |

`server/entry.ts` selects PostgreSQL whenever `DATABASE_URL` is present. `npm run build` type-checks the TypeScript/TSX source, compiles server and operational scripts into `build/`, then builds the Vite frontend. The SQLite runtime refuses a production startup, preventing accidental deployment of the demo database.

## Run locally

```bash
cd living-water-alerts
npm install
npm run build
npm start
```

Open `http://localhost:3000`.

### Demo accounts

All fictional sample accounts use password `LivingWater@2026`.

| Role | Email |
|---|---|
| Organisation Owner | `owner@livingwater.demo` |
| Membership Officer | `membership@livingwater.demo` |
| Birthday Coordinator | `birthdays@livingwater.demo` |
| Auditor | `audit@livingwater.demo` |

Do not reuse any sample account, password, SQLite data, or mock verification code in production.

### Verify the PostgreSQL runtime without a database server

```bash
npm test
# or
npm run smoke:postgres
```

The regression smoke test runs the PostgreSQL implementation against the test-only `pg-mem` compatibility layer. It verifies health readiness, CSRF, owner sign-in, atomic member-code allocation, durable birthday jobs, a WhatsApp failure followed by SMS fallback, signed Termii webhook handling, endpoint verification, staff invitations, mandatory TOTP setup, recovery-code issuance, and protected access after MFA.

This is valuable regression coverage, but it is **not a substitute** for a real managed-PostgreSQL deployment and browser HTTPS/passkey test.

## Production deployment

Use the step-by-step guide in **[docs/RENDER_DEPLOYMENT.md](docs/RENDER_DEPLOYMENT.md)** for the default Render PostgreSQL deployment. If the parish chooses Supabase PostgreSQL instead, use the reviewed **[Supabase option guide](docs/SUPABASE_OPTION.md)** and `render.supabase.yaml` rather than the default Blueprint. In brief:

1. Put this repository in a private Git provider repository and create a Render Blueprint from `render.yaml`.
2. Select a paid managed PostgreSQL plan with point-in-time recovery, and set a parish-controlled HTTPS domain before enrolling passkeys.
3. Complete the `sync:false` Render values — especially canonical URL/passkey values and Resend — before the first production application start.
4. Let the Blueprint run `npm run migrate:postgres`, then run the one-time `npm run bootstrap:owner` command in a short-lived Render Shell with bootstrap variables supplied only for that command.
5. Enrol the owner’s TOTP/passkey, save recovery codes, test invitation delivery, and configure verified staff alert endpoints.
6. Keep `MESSAGE_MODE=mock` until Meta, Termii, templates, webhook signatures, and authorised test delivery are all complete. Switch both Render services to `MESSAGE_MODE=live` together only after the production checklist passes.

The Blueprint intentionally keeps the web service scheduler disabled and runs one dedicated worker. Do not turn `SCHEDULER_ENABLED=true` on the web service while that worker is active.

## Environment variables

Copy `.env.example` only for local development. Production values belong in Render’s encrypted environment configuration, never in a committed file, frontend bundle, or chat message.

| Variable | Use |
|---|---|
| `DATABASE_URL` | Managed PostgreSQL connection string; selects the PostgreSQL runtime |
| `SESSION_SECRET`, `FIELD_ENCRYPTION_KEY`, `PHONE_HASH_KEY` | Separate high-entropy session, field-encryption, and HMAC materials |
| `APP_ORIGIN`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID` | Exact canonical HTTPS origin and relying-party ID for invitations and passkeys |
| `EMAIL_MODE=resend`, `RESEND_API_KEY`, `INVITE_FROM_EMAIL` | Verified parish sender for staff invitations; required in production |
| `MESSAGE_MODE` | `mock` or `live` only. `mock` records safe simulated delivery; `live` is startup-blocked until all Meta and Termii values are supplied |
| `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_BIRTHDAY_TEMPLATE`, `META_APP_SECRET` | Parish-owned Meta Cloud API credentials, approved template, and signed delivery webhook |
| `META_WEBHOOK_VERIFY_TOKEN`, `META_TEMPLATE_LANGUAGE`, `META_GRAPH_VERSION` | Meta webhook subscription and template/version settings |
| `TERMII_API_KEY`, `TERMII_SENDER_ID`, `TERMII_WEBHOOK_SECRET` | Termii API, approved sender ID, and Events & Reports HMAC secret |
| `TERMII_SMS_CHANNEL=dnd`, `TERMII_OTP_MODE=native` | Transactional/DND route and Termii server-verified endpoint OTP mode |
| `SCHEDULER_ENABLED`, `PG_POOL_MAX` | Scheduler ownership and PostgreSQL connection-pool sizing |

The existing Meta adapter expects an approved template with **one body variable: the authorised birthday count**. It does not place names, phone numbers, dates of birth, or a member directory in a lock-screen message.

## Provider and privacy guardrails

- Use the official **Meta WhatsApp Business Cloud API** through a parish-controlled Meta Business Portfolio and official parish number — never WhatsApp Web automation or a staff member’s personal number.
- Get an auditable opt-in for each administrator endpoint, verify control of it with OTP, and honour opt-out immediately.
- Use Termii’s approved DND/transactional route for operational SMS and its native Verify Token flow for endpoint OTP. The delivery-report webhook is verified using Termii’s `X-Termii-Signature` HMAC-SHA512 signature.
- Meta delivery callbacks are signature-verified with the App Secret. API acceptance is not treated as handset delivery.
- Follow the parish’s NDPC governance obligations: documented purpose/lawful basis, privacy notice, retention schedule, processor agreements, access review, incident procedure, staff training, and a DPIA or equivalent risk assessment before loading live member data.
- Test backup restoration and provider failure scenarios; a backup that has never been restored is not yet a trusted backup.

## Repository layout

```text
client/src/main.tsx             React/Vite TypeScript frontend
server/entry.ts                 SQLite-vs-PostgreSQL web runtime selector
server/index-pg.ts              Express PostgreSQL API, sessions, MFA, webhooks, RBAC
server/database-pg.ts           PostgreSQL adapter, encrypted fields, pg-mem test support
server/auth-pg.ts               Invitations, TOTP/recovery-code MFA and staff controls
server/notification-pg.ts       Provider delivery, outbox, idempotency and callbacks
server/worker-pg.ts             Dedicated Africa/Lagos scheduler / delivery worker
server/types.ts                 Shared role, session, request and delivery contracts
migrations/                     Immutable PostgreSQL schema migrations
scripts/migrate-postgres.ts     Checksummed migration runner
scripts/bootstrap-owner.ts      One-time secure production-owner command
scripts/smoke-test-postgres.ts  PostgreSQL regression smoke test
tsconfig.server.json            Node/Express TypeScript compilation settings
client/tsconfig.json            React/TSX type-check settings
render.yaml                     Default Render web + worker + Render PostgreSQL Blueprint
render.supabase.yaml            Optional Render web + worker + Supabase PostgreSQL Blueprint
supabase/lockdown-public-schema.sql  Supabase browser/Data API security lockdown
docs/                           Deployment and operational runbooks
```

The full product, privacy, provider, and rollout research is available at `../living-water-mega-parish-birthday-alert-system-research.md` in this workspace.
