# Hosting and going live — free tiers (Vercel + Render)

This guide takes the repository from a clean checkout to a public, HTTPS-served
application **without paying anything**, using:

- **Vercel Hobby** for the React front end (static assets, free, global CDN);
- **Render free web service** for the Express API, sessions and the birthday
  scheduler;
- **Neon free Postgres** for the database (Render's own free Postgres is
  **deleted after 30 days**, so it must not hold parish records).

> Figures and policies below were checked in **September 2026**. Free tiers
> change; confirm the current limits on the provider's pricing page before you
> commit parish data. Links are in [Provider limits](#provider-limits-verified-september-2026).

---

## 1. Why this topology

| Concern                                  | Where it runs                                      | Why                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| React SPA (`client/`)                    | Vercel                                             | Static files only. Fast, free, unlimited-ish bandwidth, no server to patch.                                                            |
| Express API, session cookies, CSRF, RBAC | Render web service                                 | Needs a long-lived Node process and a writable database.                                                                               |
| Birthday scheduler + delivery outbox     | Same Render web process (`SCHEDULER_ENABLED=true`) | **Render free instances cannot run background workers or cron jobs.** A paid worker is ~$7/month; on free you run the cron in-process. |
| PostgreSQL                               | Neon                                               | Permanent free tier (0.5 GB), never expires, scale-to-zero. Render's free Postgres expires after 30 days.                              |

**Do not** try to run the API as a Vercel serverless function: the app keeps an
`express-session` store, a `pg` connection pool and an in-process cron
scheduler, all of which assume a persistent process. Vercel's 60-second function
limit and per-invocation lifecycle would break sessions and scheduled delivery.

---

## 2. Provider limits (verified September 2026)

| Provider / plan                 | Free allowance                                                                   | Constraint that matters here                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Render** free web service     | 750 instance-hours per workspace per month (one service running 24/7 ≈ 730 h)    | Spins down after ~15 min idle → first request takes a few seconds. **No background workers, no cron jobs.** 5 GB/month egress.     |
| **Render** free Postgres        | 256 MB                                                                           | **Expires and is deleted 30 days after creation.** Not usable for real data.                                                       |
| **Neon** Free                   | 0.5 GB storage, 100 compute-hours/month per project, up to 100 projects          | Scale-to-zero: ~300–500 ms cold start after idle. Use the **pooled** connection string.                                            |
| **Supabase** Free (alternative) | 500 MB, 2 projects                                                               | Projects **pause after ~1 week of inactivity**; a paused project needs a manual resume.                                            |
| **Vercel** Hobby                | 100 GB bandwidth, 1 M function invocations, 6 000 build minutes, 100 deploys/day | **Non-commercial use only** under the Hobby ToS — a church's internal tool is normally fine, but read the ToS. 1 concurrent build. |

**Budget check:** one always-on Render free service (≈730 h) fits inside the
750-hour allowance, but only just, and only for **one** service in the
workspace. If you add a second free service you will exhaust the quota mid-month
and the API will stop.

---

## 3. Prerequisites

1. A GitHub repository containing this project.
2. Accounts: [Neon](https://neon.tech), [Render](https://render.com),
   [Vercel](https://vercel.com) — all can be created with GitHub sign-in.
3. A domain (optional but recommended; free TLS is issued automatically on both
   platforms). Passkeys/WebAuthn require HTTPS in production.

---

## 4. Step 1 — create the database (Neon)

1. Neon → **Create a project**. Region: pick the one closest to Render's region
   (Frankfurt `aws-eu-central-1` if you deploy to Render Frankfurt).
2. Neon creates a role and database. Copy the **pooled** connection string —
   it looks like
   `postgresql://user:password@ep-xxxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require`.
   The pooled endpoint (`-pooler`) is the one to use; it survives connection
   churn and scale-to-zero better than a direct connection.
3. Keep that string somewhere private. It is a secret: anyone holding it can
   read every member record.

**Do not** create a Render free Postgres for this data. It is deleted after
30 days.

---

## 5. Step 2 — run the migrations once

Migrations are plain SQL in `migrations/` and are applied by
`scripts/migrate-postgres.ts` (checksummed, so a migration that was already
applied is skipped and a migration that changed after being applied is
rejected).

From your workstation:

```bash
npm ci
npm run build:server
DATABASE_URL='postgresql://user:password@ep-…-pooler…/neondb?sslmode=require' \
  npm run migrate:postgres
```

Expected output:

```
apply 001_initial_postgres.sql
apply 002_session_store.sql
apply 003_member_code_sequence.sql
```

Render also runs `npm run migrate:postgres` as a `preDeployCommand` in the
blueprint, so later migrations are applied on every deploy.

---

## 6. Step 3 — deploy the API to Render (free)

### 6a. Create the service

Render → **New +** → **Web Service** → connect the repository.

| Setting            | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| Name               | `living-water-api` (this becomes `living-water-api.onrender.com`) |
| Region             | Frankfurt (match Neon)                                            |
| Branch             | `main`                                                            |
| Runtime            | Node                                                              |
| **Instance type**  | **Free**                                                          |
| Build command      | `npm ci && npm run build`                                         |
| Pre-deploy command | `npm run migrate:postgres`                                        |
| Start command      | `npm start`                                                       |
| Health check path  | `/api/health/live`                                                |

> Use `/api/health/live` for the platform health check: it answers **without
> touching the database**, so a cold Neon database cannot make Render mark a
> healthy instance as failed. Use `/api/health` for uptime monitoring that
> should notice database trouble.

### 6b. Environment variables

Create a Render **Environment Group** (e.g. `living-water`) so the values are
reusable, then attach it to the service.

**Required:**

| Variable                    | Example / notes                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                  | `production`                                                                                              |
| `DATABASE_URL`              | Neon **pooled** connection string                                                                         |
| `SESSION_SECRET`            | ≥32 random chars. `openssl rand -base64 48`                                                               |
| `FIELD_ENCRYPTION_KEY`      | 32 random bytes, base64. Encrypts member phone numbers. **Losing it makes stored numbers unrecoverable.** |
| `PHONE_HASH_KEY`            | 32 random bytes, base64. Used for duplicate detection. Rotating it breaks duplicate matching.             |
| `META_WEBHOOK_VERIFY_TOKEN` | Any long random string you also give Meta.                                                                |
| `APP_ORIGIN`                | `https://living-water.vercel.app` (the Vercel URL, no trailing slash)                                     |
| `WEBAUTHN_ORIGIN`           | Same as `APP_ORIGIN`                                                                                      |
| `WEBAUTHN_RP_ID`            | `living-water.vercel.app` (host only, no scheme)                                                          |
| `CORS_ORIGINS`              | `https://living-water.vercel.app`                                                                         |
| `SCHEDULER_ENABLED`         | `true` ← **required on a free instance** (no separate worker available)                                   |

Generate secrets locally and paste them into Render's UI — never into git, chat
or an issue:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 32   # FIELD_ENCRYPTION_KEY
openssl rand -base64 32   # PHONE_HASH_KEY
openssl rand -hex 24      # META_WEBHOOK_VERIFY_TOKEN
```

**Recommended:**

| Variable                     | Value                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| `MESSAGE_MODE`               | `mock` until provider onboarding is complete, then `live`               |
| `EMAIL_MODE`                 | `resend` (plus `RESEND_API_KEY`, `INVITE_FROM_EMAIL`) or `log`          |
| `TZ`                         | `Africa/Lagos`                                                          |
| `PG_POOL_MAX`                | `5` (Neon free has a small connection limit; the pooled endpoint helps) |
| `PG_SSL_REJECT_UNAUTHORIZED` | leave unset/`true`                                                      |
| `LOG_LEVEL`                  | `info`                                                                  |
| `TOTP_ISSUER`                | `Living Water Mega Parish`                                              |

**Only when going live with real messaging:** `META_WHATSAPP_TOKEN`,
`META_PHONE_NUMBER_ID`, `META_BIRTHDAY_TEMPLATE`, `META_APP_SECRET`,
`TERMII_API_KEY`, `TERMII_SENDER_ID`, `TERMII_WEBHOOK_SECRET`.

The full list with descriptions is in [`.env.example`](../.env.example); the
server refuses to boot in production if a required secret is missing, and tells
you which one.

### 6c. Create the first owner

Render free has no shell, so create the owner account from your workstation
against the production database:

```bash
DATABASE_URL='postgresql://…/neondb?sslmode=require' npm run bootstrap:owner
```

It prints a single-use password. Sign in, complete MFA enrollment, then store
the recovery codes offline.

---

## 7. Step 4 — deploy the SPA to Vercel (free)

1. Vercel → **Add New… → Project** → import the same repository.
2. Framework preset: **Vite**.
3. Build settings — leave **Root Directory empty** so Vercel uses the single
   `package.json` at the repository root:

   | Setting          | Value                  |
   | ---------------- | ---------------------- |
   | Root directory   | _(leave empty)_        |
   | Framework preset | Vite                   |
   | Build command    | `npm run build:client` |
   | Output directory | `client/dist`          |
   | Install command  | `npm ci`               |

   `npm run build:client` runs `vite build --config client/vite.config.ts`,
   which resolves its own root from the config file location, so it works from
   the repository root and emits the bundle into `client/dist`.

4. Environment variables (Production **and** Preview):

   | Variable            | Value                                   |
   | ------------------- | --------------------------------------- |
   | `VITE_API_BASE_URL` | `https://living-water-api.onrender.com` |

   `VITE_*` variables are inlined at **build** time, so after changing one you
   must redeploy.

5. Deploy. You now have `https://<project>.vercel.app`. Put that exact origin
   into Render's `APP_ORIGIN`, `WEBAUTHN_ORIGIN` (host only) and
   `CORS_ORIGINS`, then redeploy the API.

### SPA rewrites

`vercel.json` at the repository root already contains the rewrite that sends
every non-asset path to `index.html` (Vercel reads `vercel.json` from the Root
Directory, which is why the Root Directory is left empty). That is what makes `/invite/:token` (the link
emailed to new staff) and deep links such as `/members` survive a refresh:

```json
{ "rewrites": [{ "source": "/((?!api/).*)", "destination": "/index.html" }] }
```

---

## 8. Step 5 — make split hosting work

When the SPA and API are on different origins, four things must line up. If
sign-in loops or CSRF fails, check them in this order:

1. **CORS** — `CORS_ORIGINS` on the API must exactly match the Vercel origin
   (scheme + host, no trailing slash, no wildcard). The API answers preflights
   and sets `Access-Control-Allow-Credentials: true`.
2. **Cookies** — the app detects a cross-origin deployment and switches the
   session cookie to `SameSite=None; Secure=true`. That only works over HTTPS,
   which both platforms provide.
3. **CSRF** — the browser sends `x-csrf-token` on every unsafe request; the
   client fetches it from `GET /api/auth/csrf` and refreshes it automatically if
   the server rejects it. Nothing to configure.
4. **WebAuthn** — `WEBAUTHN_ORIGIN` must be the Vercel origin and
   `WEBAUTHN_RP_ID` its host. A mismatch makes every passkey ceremony fail with
   `PASSKEY_VERIFICATION_FAILED`.

Verify with:

```bash
curl -i https://living-water-api.onrender.com/api/health/live
curl -i https://living-water-api.onrender.com/api/health
```

---

## 9. Step 6 — provider webhooks (only when `MESSAGE_MODE=live`)

| Provider                 | Callback URL                                                  | Authentication                                                                                                                      |
| ------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Meta WhatsApp Cloud API  | `https://living-water-api.onrender.com/api/webhooks/whatsapp` | `hub.verify_token` = `META_WEBHOOK_VERIFY_TOKEN`, then HMAC-SHA256 over the raw body with `META_APP_SECRET` (`x-hub-signature-256`) |
| Termii delivery receipts | `https://living-water-api.onrender.com/api/webhooks/sms`      | HMAC-SHA512 over the raw body with `TERMII_WEBHOOK_SECRET` (`x-termii-signature`)                                                   |

Both endpoints are exempt from CSRF (they are authenticated by signature
instead) and both reject an invalid signature with `401`.

**Cold-start warning:** on a free Render instance the first webhook after an
idle period may arrive while the service is still waking up. Providers retry;
the handler is idempotent by `notification_key`, so a retry cannot duplicate a
message.

---

## 10. Going-live checklist

Before flipping `MESSAGE_MODE` to `live`:

- [ ] Migrations applied; `npm run migrate:postgres` reports `skip` for all three.
- [ ] Owner account created, MFA enrolled, recovery codes stored offline.
- [ ] `/api/health` returns `{"ok":true,"database":"postgresql",…}`.
- [ ] Sign-in works from the Vercel URL, including MFA and a passkey.
- [ ] A test endpoint received a real SMS verification code and verified.
- [ ] "Send a test alert" produced a `delivered` row in the delivery log.
- [ ] Provider webhooks verified (Meta's webhook UI shows a green check).
- [ ] Staff invited with the roles they need; coordinators scoped to their groups.
- [ ] CSV import dry-run reviewed (preview → commit only the valid rows).
- [ ] `MESSAGE_MODE=live` set, service redeployed, one real digest confirmed.
- [ ] Database backup/branch schedule decided (Neon: automatic PITR on paid,
      manual branch or `pg_dump` on free).

**Backup on a free tier:** Neon's free plan does not include scheduled backups.
Add a weekly `pg_dump` from a free scheduled runner (for example a GitHub Action
on a cron schedule writing to a private artifact or S3-compatible bucket). Member
phone numbers are encrypted at rest with `FIELD_ENCRYPTION_KEY`, so a backup is
useless without that key — store the key separately from the dump.

---

## 11. Operating a free deployment

**Cold starts.** Render free spins the service down after ~15 minutes idle and
Neon scales the database to zero. The first request can take several seconds.
Mitigations:

- Keep the health-check path at `/api/health/live` so Render does not restart a
  waking instance.
- Add an external uptime ping every 10 minutes (UptimeRobot, cron-job.org,
  Better Stack — all have free tiers) to keep both the app and the database warm.
  This is the single most effective free-tier trick.

**The scheduler.** `SCHEDULER_ENABLED=true` runs a `node-cron` tick every minute
inside the web process. While the instance is asleep nothing runs, so the digest
is sent at the first tick after wake-up — typically within a minute of the ping
above, not exactly at 07:30. If precise timing matters, that is the moment to
move to a paid worker (`render.yaml` in this repo defines one).

**Idempotency.** Delivery is keyed per member/day/rule, so a late or repeated
tick cannot send two digests to the same person.

**Logs.** Render keeps logs for the current instance; free instances lose them on
restart. Set `LOG_LEVEL=info` and rely on the in-app audit trail for anything
that must be retained (it is written to the database).

**Zero-downtime deploys** are not available on free instances; expect a few
seconds of downtime per deploy.

---

## 12. When to start paying

| Trigger                                              | Cheapest fix                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Digest timing must be exact, or you need >1 instance | Render Starter web service (~$7/mo) + worker, or move the API to a $5 VPS |
| More than 0.5 GB of member data                      | Neon Launch (~$19/mo) or Render Postgres Basic (~$7/mo)                   |
| Commercial use of the front end                      | Vercel Pro ($20/mo) — Hobby is non-commercial                             |
| You must not lose data                               | Any paid Postgres tier with automated backups + PITR                      |

A sensible first paid step is **Render Starter for the API + Neon Launch for the
database**, keeping the SPA on Vercel Hobby if the non-commercial clause applies
to your use.

---

## 13. Alternative: everything on Render (no Vercel)

`npm run build` compiles the API **and** the SPA into `client/dist`, and
`server/app.ts` serves that directory with an SPA fallback. So a single Render
free service can host the whole product:

- Delete or ignore the Vercel project.
- Unset `VITE_API_BASE_URL` (the client then uses relative URLs) and unset
  `CORS_ORIGINS` (same-origin, so cookies stay `SameSite=Lax`).
- Keep `APP_ORIGIN=https://living-water-api.onrender.com`.

Trade-off: no CDN for static assets and one more thing competing for the 750
free instance-hours — but one fewer platform, no CORS, and no cookie
`SameSite=None` requirement. For an internal church tool this is often the
better choice.

---

## 14. Troubleshooting

| Symptom                                              | Cause                                                              | Fix                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Sign-in succeeds then bounces back to the login page | Cookies blocked: `SameSite=None` without HTTPS, or origin mismatch | Confirm both URLs are `https://`, and `CORS_ORIGINS` matches exactly                                              |
| `CSRF_INVALID` on every POST                         | Session cookie not being sent                                      | Check `CORS_ORIGINS`, and that `credentials: 'include'` traffic is allowed (it is, in `client/src/api/client.ts`) |
| `PASSKEY_VERIFICATION_FAILED`                        | `WEBAUTHN_ORIGIN`/`WEBAUTHN_RP_ID` mismatch, or non-HTTPS origin   | Set origin to the Vercel URL and RP ID to its host                                                                |
| Deploy succeeds, `/api/health` 503                   | `DATABASE_URL` wrong, or Neon project suspended                    | Re-check the pooled URL; open the Neon console and resume the project                                             |
| Boot fails with a config error                       | A required secret is missing                                       | The error names the variable; add it to the Render env group                                                      |
| First request after idle times out                   | Free-tier cold start                                               | Add an uptime ping; use `/api/health/live` for the platform check                                                 |
| SPA refresh on `/members` gives 404                  | Missing rewrite                                                    | Keep `vercel.json` in the repo (or use the single-service option in §13)                                          |
| Digests never send                                   | `MESSAGE_MODE=mock`, rule disabled, or scheduler off               | Check Settings in the app, then `SCHEDULER_ENABLED=true`                                                          |

---

## 15. Related documents

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — how the system is put together.
- [`docs/RENDER_DEPLOYMENT.md`](./RENDER_DEPLOYMENT.md) — the paid, production-grade Render blueprint (dedicated worker, managed Postgres).
- [`docs/SUPABASE_OPTION.md`](./SUPABASE_OPTION.md) — using Supabase instead of Neon.
- [`.env.example`](../.env.example) — every configuration variable, documented.
