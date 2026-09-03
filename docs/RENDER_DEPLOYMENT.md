# Render production deployment runbook

This runbook deploys Living Water Birthday Care as a **private staff system** with Render managed PostgreSQL, a separate web service, and exactly one delivery worker. Complete the steps in order. A production deploy should never use the seeded SQLite demo database, demo accounts, personal WhatsApp, or mock credentials.

## 1. Decide the parish-owned production identity

Before creating Render resources, record these decisions in the parish’s controlled password manager / operations register:

- A canonical staff-only HTTPS hostname, for example `birthday-care.your-parish-domain.org`.
- A verified staff-invitation sender such as `birthday-care@your-parish-domain.org`.
- At least two accountable Organisation Owners, their business email addresses, and a recovery/incident contact path.
- The approved data purpose, privacy notice version, retention schedule, access-review cadence, and who may see member phones or birthday lists.
- A parish-owned Meta Business Portfolio, WhatsApp Business Account, and official business phone number — not any volunteer’s personal WhatsApp account.
- A Termii account owned by the parish, with billing, Sender ID, DND/transactional route, webhook secret, and recovery contacts under parish control.

Use a dedicated custom domain before enrolling passkeys. Passkeys bind to a relying-party ID and changing a temporary `onrender.com` hostname later causes needless re-enrolment.

## 2. Place the project in private source control

1. Create a **private** GitHub, GitLab, or Bitbucket repository owned by the parish or its authorised technology team.
2. Review `.gitignore` and confirm that `.env`, databases, exported CSVs, screenshots containing member information, and provider credentials are never committed.
3. Push the reviewed project, including `render.yaml`, `migrations/`, and `docs/`.
4. Turn on protected main-branch review and dependency/security alerts where available.

Do not publish a public live preview containing real member records.

## 3. Create Render resources from the Blueprint

1. In Render, choose **New → Blueprint** and connect the private repository.
2. Review `render.yaml`. It creates:
   - `living-water-birthday-care` — the HTTPS web/API service;
   - `living-water-birthday-care-worker` — the only recurring scheduler and outbox worker;
   - `living-water-alerts-db` — managed PostgreSQL in the same Render region.
3. Use a paid PostgreSQL plan with point-in-time recovery (PITR); confirm the currently offered retention period in Render before approval. Keep the database on Render’s private network (`ipAllowList: []`) unless a controlled administration connection is explicitly needed.
4. Keep the initial web and worker counts at one. Web instances may be deliberately scaled later because sessions are PostgreSQL-backed, but never run two scheduler workers without an intentional design review.
5. Confirm the web health check is `/api/health`. It makes a database query, so Render removes an unhealthy instance rather than accepting a process that cannot reach PostgreSQL.

The web service runs `npm run migrate:postgres` as its pre-deploy command. Migrations are checksummed and immutable: add a new migration rather than editing one already used in a real environment.

## 4. Fill the encrypted environment values before starting production

Render will generate shared values for `SESSION_SECRET`, `FIELD_ENCRYPTION_KEY`, `PHONE_HASH_KEY`, and the Meta verify token in the `living-water-common` environment group. Do not replace generated values casually; changing field-encryption or HMAC material without a planned data migration can make existing encrypted data unreadable or duplicate detection inconsistent.

Supply every `sync:false` value in Render’s encrypted environment UI:

| Key | Production value / rule |
|---|---|
| `APP_ORIGIN` | Exact canonical URL, e.g. `https://birthday-care.your-parish-domain.org` |
| `WEBAUTHN_ORIGIN` | The same exact HTTPS URL |
| `WEBAUTHN_RP_ID` | Host only, e.g. `birthday-care.your-parish-domain.org`; no scheme or path |
| `RESEND_API_KEY` | Resend key held only in Render’s encrypted store |
| `INVITE_FROM_EMAIL` | A sender on a verified parish domain, for example `Living Water Birthday Care <birthday-care@your-parish-domain.org>` |
| `META_*` values | Leave blank while `MESSAGE_MODE=mock`; complete during Meta onboarding |
| `TERMII_API_KEY`, `TERMII_SENDER_ID`, `TERMII_WEBHOOK_SECRET` | Leave blank while `MESSAGE_MODE=mock`; complete during Termii onboarding |

`EMAIL_MODE=resend` is intentional: a production server refuses to start if staff invitations would silently fall back to mock email. `MESSAGE_MODE=mock` is also intentional: it records simulated messages but makes no real WhatsApp or SMS call. Production accepts only `mock` and `live`.

Set up the custom domain and HTTPS certificate in Render, then enter the exact values above. The application refuses PostgreSQL production startup without the canonical/passkey settings and Resend configuration.

## 5. Deploy schema and create the first owner safely

After the first successful build and migration, open a short-lived **Render Shell** for the web service. Supply bootstrap values only for the command; do not add them to the shared environment group or commit them.

```bash
read -r -p 'Owner full name: ' BOOTSTRAP_OWNER_NAME
read -r -p 'Owner email: ' BOOTSTRAP_OWNER_EMAIL
read -r -s -p 'Temporary 12+ character owner password: ' BOOTSTRAP_OWNER_PASSWORD; echo
export BOOTSTRAP_OWNER_NAME BOOTSTRAP_OWNER_EMAIL BOOTSTRAP_OWNER_PASSWORD
npm run bootstrap:owner
unset BOOTSTRAP_OWNER_NAME BOOTSTRAP_OWNER_EMAIL BOOTSTRAP_OWNER_PASSWORD
```

The command creates an Organisation Owner only when no active owner exists. It refuses weak passwords and refuses to create a second bootstrap owner. On first sign-in, the owner must enrol TOTP or a passkey before reaching the dashboard. Store recovery codes in an approved parish-controlled password manager, not in chat or an ordinary group message.

Immediately:

1. Confirm `https://your-host/api/health` returns HTTP 200 and `{ "ok": true, "database": "postgresql" }`.
2. Sign in as the owner; enrol TOTP and, after confirming the custom domain, a passkey.
3. Invite a second owner through the product and verify the invitation arrives from the verified parish sender.
4. Verify a test staff alert endpoint with OTP. While in mock mode, it will be recorded but not sent to a handset.
5. Review the audit log, group-scoped birthday view, and member permissions before importing any live data.

## 6. Load live member records deliberately

For a new production parish, prefer the reviewed CSV import workflow inside the application. It validates rows, rejects formula-like cells, requires review, and does not retain the raw uploaded CSV.

Only use `npm run import:sqlite:postgres` for a carefully reviewed migration of an existing **authorised** SQLite installation. It copies encrypted values rather than decrypting them. Therefore its source encryption/HMAC settings must be understood and preserved for the import; do not use it to copy the fictional demo database. Take and test a source backup first, run `npm run migrate:postgres`, keep the target empty, validate counts and sample access, and obtain explicit approval before cutover.

## 7. Complete real delivery onboarding

Keep both services on `MESSAGE_MODE=mock` until every item below passes.

### Meta WhatsApp Cloud API

1. Use the parish-owned Meta Business Portfolio and WhatsApp Business Account. Register a parish-controlled official number and enable the required six-digit two-step verification.
2. Complete business/payment verification as required by Meta for business-initiated templates.
3. Create and obtain approval for a birthday-care template whose body accepts one variable: the count of authorised birthdays. Do **not** add member names, phone numbers, dates of birth, or directory links to the message.
4. Configure Meta callbacks to `https://your-host/api/webhooks/whatsapp`, subscribe to delivery status events, and use the Blueprint-generated `META_WEBHOOK_VERIFY_TOKEN` in the subscription check.
5. Set `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_BIRTHDAY_TEMPLATE`, and `META_APP_SECRET` in Render’s encrypted environment values. Use an appropriately scoped system-user token and plan token rotation.
6. Send only an authorised test digest to a verified administrator endpoint. Confirm both the application delivery record and the Meta delivery callback.

### Termii SMS and endpoint OTP

1. Use the parish Termii account; activate the approved Sender ID and the transactional/DND route. Do not use the generic promotional route for critical operational messages or OTP.
2. Set `TERMII_API_KEY`, `TERMII_SENDER_ID`, and `TERMII_WEBHOOK_SECRET` in Render. `TERMII_WEBHOOK_SECRET` is the secret used by Termii Events & Reports to create the `X-Termii-Signature` HMAC-SHA512 header.
3. In Termii’s webhook configuration, use `https://your-host/api/webhooks/sms`. The application rejects unsigned or incorrectly signed Termii callbacks.
4. Test a number-owner OTP and an authorised delivery report. Confirm that `Delivered`, `DND Active`, `Message Failed`, `Rejected`, and `Expired` are recorded correctly.

After both providers and callbacks work with authorised test numbers, change `MESSAGE_MODE` from `mock` to `live` **in the shared Render environment group** and redeploy both web and worker services. The production runtime blocks a live start if Meta, Termii, template, or webhook-signature credentials are missing. Confirm a safe test alert before relying on the 07:30 schedule.

## 8. Daily operations and failure handling

- The worker evaluates the rule in `Africa/Lagos` every minute and runs it once when the configured time (default 07:30) matches. It then processes due delivery jobs.
- A notification key prevents a duplicate digest for the same birthday date, lead time, staff recipient, and channel.
- Jobs are claimed with PostgreSQL row locking, retried with bounded exponential delay, and become `dead_letter` after five failed attempts. Review failed/dead-letter notifications at least daily and document remediation.
- If a WhatsApp birthday digest later receives a failed provider callback, the system queues a single SMS fallback for a verified, opted-in SMS endpoint. It does not expose member PII in either channel.
- Provider acceptance is not handset delivery. Treat `provider_accepted`, `sent`, `delivered`, `read`, `failed`, and `dead_letter` as distinct operational states.
- Add, verify, disable, or opt out administrator endpoints through the product. Never alter encrypted phone values directly in PostgreSQL.
- Run an access review monthly: deactivate departed staff, revoke unused invitations, confirm owner count, and review assigned group scopes.

## 9. Backup, restore, monitoring, and incidents

### Backups

1. Enable/retain a paid Render PostgreSQL plan with PITR and confirm its retention period and restore process in the Render dashboard.
2. At least quarterly, restore to a **separate non-production database**, validate migration/version and authorised sample access, document the result, then destroy the test restore. Do not test restoration over the production database.
3. Add a second, encrypted, access-controlled logical backup destination (for example S3) if the parish’s retention objective exceeds Render PITR. Use Render’s documented PostgreSQL-to-S3 backup process and a dedicated least-privilege storage credential; keep its encryption and restore test under the parish’s control.
4. Maintain a separate secure record of encryption/HMAC key custody. A database backup alone is insufficient if the necessary application keys are unavailable; keys must remain protected and access-controlled.

### Monitoring

- Alert on web health-check failures, worker crashes/restarts, database connection exhaustion, delivery failures/dead letters, and unusual sign-in failure rates.
- Review Render service logs after releases and provider dashboard status after a test message.
- Pin operational owners for Meta, Termii, Render, DNS, and Resend so an individual volunteer’s departure does not lock the parish out.

### Incident response

If a phone, staff account, token, or message endpoint may be compromised:

1. Disable the affected endpoint or deactivate the user immediately in the application.
2. Rotate the relevant provider token/secret in Render; revoke exposed provider sessions at the provider.
3. Preserve the minimum necessary audit/log evidence, assess affected data and recipients, and follow the parish’s privacy/NDPC incident procedure.
4. Do not rotate `FIELD_ENCRYPTION_KEY` or `PHONE_HASH_KEY` impulsively; plan a controlled decrypt/re-encrypt migration first.
5. Record the remediation and perform a short post-incident access review.

## 10. Release gate

Do not declare the service live until an authorised owner signs this checklist:

- [ ] Private source repository and no secrets/PII committed.
- [ ] Custom HTTPS domain, exact passkey origin/RP ID, and owner MFA tested.
- [ ] Render health check, PostgreSQL migration, database private network, and tested restore documented.
- [ ] Two accountable owners and invitation delivery tested.
- [ ] Privacy notice, lawful-basis/consent process, retention, access review, and incident process approved.
- [ ] Meta parish-owned business assets, approved template, signed webhook, and authorised test completed.
- [ ] Termii Sender ID/DND route, signed webhook, OTP, and authorised test completed.
- [ ] `MESSAGE_MODE=live` set only after the above; default rule and verified recipient endpoints reviewed.
- [ ] Daily delivery, provider callback, WhatsApp failure → SMS fallback, and dead-letter review tested.
