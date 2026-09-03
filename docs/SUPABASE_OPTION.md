# Supabase PostgreSQL option

## Recommendation

**Yes — Supabase is a suitable production database choice for Living Water Birthday Care.** For the parish’s size and this product’s needs, choose a **Supabase Pro** PostgreSQL project in **Frankfurt (`eu-central-1`)**, and keep the existing Render web service and dedicated worker initially.

Supabase gives the parish a managed PostgreSQL database, a strong dashboard, managed backups, optional Auth/passkeys/TOTP for a later identity migration, and useful future capabilities such as secure Storage. Frankfurt is the closest broadly available Supabase region to Port Harcourt among the documented general regions.

However, the current application already has a tested Express authentication/MFA/session layer and a durable Node worker. Do **not** rush to replace those with Supabase Auth during the database move. First move only PostgreSQL, keep the browser talking to the same Express API, and perform an Auth/RLS redesign later as a separate, reviewed project.

### Supabase versus Render PostgreSQL

| Choice | Best when | Trade-off |
|---|---|---|
| **Supabase PostgreSQL Pro (recommended if the parish wants Supabase’s console/Auth/Storage roadmap)** | Parish prefers the Supabase administrative experience and may later adopt Supabase Auth, Storage, or Realtime | The database is a separate platform from Render, so network restriction and Data API lockdown must be performed carefully |
| **Render PostgreSQL** | Lowest operational complexity and private same-platform networking are the overriding priority | Fewer integrated database-management and future platform features |

Both are standard PostgreSQL. The TypeScript server, migrations, row locks, session store, encrypted fields, and outbox work with either; changing providers does not require a data-model rewrite.

## Required design choices

1. **Use Supabase Pro, not Free, for live parish data.** Free projects may pause and do not offer downloadable database backups. Confirm current backup/PITR terms and budget before launch.
2. **Create the project in Frankfurt** and deploy Render web/worker in Frankfurt as configured, avoiding unnecessary cross-region latency.
3. **Use a server-only PostgreSQL connection.** Do not add Supabase URL, publishable/anon key, secret key, or service-role key to `client/` or the browser.
4. **Use Supavisor session-pooler mode on port 5432** for the long-running Render web service and worker if Render cannot use Supabase’s IPv6 direct connection. Supabase documents direct connections as ideal for persistent servers, but they are IPv6-only unless an IPv4 add-on is present; session mode is the safe persistent-backend alternative. Do not use transaction-pooler mode for the Express PostgreSQL session store/long transactions without a specific compatibility review.
5. **Keep `PG_POOL_MAX=5` initially.** The web and worker need only a small bounded pool. Raise it only after observing Supabase connection metrics and accounting for Supabase internal services.
6. **Require TLS.** The optional Blueprint sets `PGSSLMODE=require`; the server verifies certificates by default. Never set `PG_SSL_REJECT_UNAUTHORIZED=false` merely to bypass a connection issue without investigating the certificate/path.

## Deployment steps

### A. Create and secure the Supabase project

1. Create a Supabase **Pro** project in Frankfurt / `eu-central-1` under a parish-controlled organisation account.
2. Enable SSL enforcement and Network Restrictions. Restrict database access to the controlled application path where Supabase’s plan/network model allows it. Keep the database password and any project-management access in the parish password manager.
3. From **Connect**, copy the **Supavisor Session mode** connection string (port `5432`) for Render if a direct IPv6 connection is unavailable. This is `DATABASE_URL`; it is secret and belongs only in Render’s encrypted configuration.
4. Do not expose the PostgREST/Data API to the frontend for this application. After migrations, run [`../supabase/lockdown-public-schema.sql`](../supabase/lockdown-public-schema.sql) in the Supabase SQL Editor. It revokes `anon`/`authenticated` Data API access to internal tables and enables RLS with no browser-access policies.
5. Keep `SUPABASE_SECRET_KEY` / legacy `service_role` keys out of this project unless a later server-only Supabase API integration genuinely needs one. Such keys bypass RLS and must never be browser-visible.

### B. Deploy the TypeScript app on Render

1. In Render choose **New → Blueprint**, connect the private repository, and select `render.supabase.yaml` instead of `render.yaml`.
2. Fill every `sync:false` variable in the `living-water-supabase-common` group. At minimum, production start requires the canonical HTTPS/passkey values plus Resend invitation delivery values.
3. Paste the session-mode Supabase `DATABASE_URL` into the encrypted `DATABASE_URL` field for **both** Render services. Set neither the URL nor its password in a committed `.env` file. If the project has a reachable direct endpoint, add a web-service-only `MIGRATIONS_DATABASE_URL` with that direct administration URL; the migration command prefers it while normal runtime traffic continues to use the session pooler.
4. The web service runs `npm run migrate:postgres` before each deploy. For first deployment, verify the migration output in Render logs. Supabase recommends a direct connection for migrations; if the direct endpoint is not reachable from Render, the command safely falls back to `DATABASE_URL`/Supavisor session mode. If your Supabase connection/network policy prevents Render pre-deploy migration, run `npm run migrate:postgres` once from an approved administration environment using the direct connection, then re-enable the normal migration gate.
5. Run `supabase/lockdown-public-schema.sql` in Supabase SQL Editor after the first migration creates all tables, including `user_sessions` and `schema_migrations`.
6. Run the one-time `npm run bootstrap:owner` command in a short-lived Render Shell, as described in the Render deployment runbook. Enrol owner MFA before importing live data.
7. Keep `MESSAGE_MODE=mock` until the Meta and Termii onboarding/test checklist is complete.

## Backup and recovery requirements

- Supabase documents daily backups for projects and PITR as a paid add-on. Pro currently provides access to recent daily backups; PITR offers finer recovery points but is a separate budget item. Confirm current retention and pricing in the dashboard before launch.
- For a church member database, keep an additional encrypted off-platform logical export under parish-controlled access, and test a restore to a separate non-production project at least quarterly.
- Backups do not protect the application encryption keys by themselves. Maintain controlled recovery access to `FIELD_ENCRYPTION_KEY` and `PHONE_HASH_KEY`; do not rotate either without a planned re-encryption/rehash migration.

## Future optional phase: Supabase Auth

Supabase Auth supports TOTP MFA and passkeys, but its passkey documentation currently labels the feature **experimental**. Do not replace this application’s existing WebAuthn/passkey implementation merely because the database moves. An eventual Auth migration changes identity/session ownership, invitation workflow, audit model, recovery codes, authorization claims, RLS policies, and tests. Treat it as a separate migration with a staging environment, user-by-user transition plan, rollback, and RLS allow/deny tests — not as a checkbox during the database switch.

## Sources to verify during deployment

- Supabase production checklist: <https://supabase.com/docs/guides/deployment/going-into-prod>
- PostgreSQL connection modes and poolers: <https://supabase.com/docs/guides/database/connecting-to-postgres>
- Backup/PITR guidance: <https://supabase.com/docs/guides/platform/backups>
- RLS and API-role lockdown: <https://supabase.com/docs/guides/database/postgres/row-level-security>
- Passkeys: <https://supabase.com/docs/guides/auth/passkeys>
