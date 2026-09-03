# Contributing

This system holds real people's names, birthdays and phone numbers, and it sends
messages to real phones. Everything below exists to keep that safe.

---

## Quick start

```bash
npm ci                       # install (use --ignore-scripts if better-sqlite3 fails to build)
npm run dev:demo             # API + in-memory Postgres + seeded demo data on :3000
npm run dev                  # Vite dev server on :5173, proxying /api to :3000
npm run check                # typecheck + lint + unit tests + end-to-end smoke test
```

`npm run dev:demo` seeds four fictional accounts
(`owner@`, `membership@`, `birthdays@`, `audit@livingwater.demo`, password
`LivingWater@2026`) and three members, two of whom have a birthday today in
Africa/Lagos so the delivery path is immediately visible.

Node **20.19+** is required.

---

## Before you open a pull request

`npm run check` must pass. It runs, in order:

1. `typecheck` — strict TypeScript for both the server and the client. `strict`,
   `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and `noUnusedLocals` are
   all on. **Type errors are fixed, not suppressed.** A `@ts-expect-error` needs
   a comment explaining why the compiler is wrong.
2. `lint` — type-aware ESLint (`--max-warnings=0`). It catches floating
   promises, unsafe `any`, non-`Error` promise rejections and unused imports.
3. `test` — Vitest: domain rules, presentation helpers and the WCAG contrast
   tests that read `tokens.css`.
4. `smoke:postgres` — boots the real Express app on pg-mem and drives it over
   HTTP, including delivery, webhooks, RBAC and MFA enrollment.

Formatting is Prettier: `npm run format` (CI runs `npm run format:check`).

---

## Conventions

**TypeScript**

- `import type` for type-only imports (enforced by `verbatimModuleSyntax`).
- Never `any`. Use `unknown` and narrow. `@typescript-eslint/no-explicit-any` is
  an error.
- Prefer a Zod schema at the boundary (route handlers, CSV rows, webhook
  payloads) over hand-written checks.

**Server**

- `routes → services → database/domain`. A route validates and responds; a
  service owns the use case and writes the audit entry; `domain/` holds pure
  rules with unit tests and must not import the database or Express.
- Express 5 rejects promises returned from handlers. **Do not** wrap handlers in
  `try/catch` or an `asyncHandler` — throw an `ApiError` and let
  `server/http/error-handler.ts` answer.
- All configuration comes from `server/config.ts`. Do not read `process.env`
  anywhere else; add the variable to the Zod schema and to `.env.example`.
- Every new API error needs a stable `code` (the client switches on it).

**Client**

- Data comes through `client/src/api/` — a component never calls `fetch`.
- Every screen implements four states: skeleton loading, populated, empty and
  error. Empty states distinguish "no data yet" from "no results for these
  filters" and offer a way out.
- No hard-coded colours, spacing or radii — use a token from
  `client/src/styles/tokens.css`. If you need a new one, add it there and extend
  the contrast test.
- Accessibility is part of the feature: visible focus, `aria-live` for status
  messages without stealing focus, 24×24 px minimum targets, labels on every
  control, and no hover-only affordances.

**Data**

- Never log a phone number, a verification code, a recovery code or a provider
  secret.
- Phone numbers are written through `encryptValue` and looked up through
  `lookupHash`. Never store a plaintext number, even temporarily.
- Masking happens on the server, in the DTO mapper — not in the browser.
- Migrations are additive and numbered. **Never edit an applied migration**; the
  checksum guard will reject the deploy.

---

## Adding an endpoint

1. DTOs in `server/types.ts`, mirrored in `client/src/api/types.ts`.
2. Pure rules in `server/domain/` + a `__tests__` suite.
3. Use case in `server/services/`, including its `audit(...)` call.
4. Route in `server/routes/` with a Zod schema; mount it in `server/app.ts`.
5. Typed wrapper in `client/src/api/index.ts`.
6. Screen in `client/src/features/<name>/`.
7. `npm run check`.

---

## Commit and branch hygiene

- One logical change per commit. Imperative subject, ≤72 characters.
- Never commit `.env`, a database dump, a member CSV, or a screenshot
  containing real names or numbers.
- Keep generated output (`build/`, `client/dist/`, `coverage/`) out of git —
  `.gitignore` already covers them.

---

## Security issues

Do **not** open a public issue for a vulnerability. Email the maintainers
privately with reproduction steps and affected versions. Assume any leaked
`FIELD_ENCRYPTION_KEY` or `PHONE_HASH_KEY` requires rotation and a member-data
review, and treat an exposed member CSV as a data breach.

---

## Where to read next

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the system fits together.
- [`docs/HOSTING.md`](docs/HOSTING.md) — deploying on free tiers (Vercel + Render).
- [`.env.example`](.env.example) — every configuration variable, documented.
