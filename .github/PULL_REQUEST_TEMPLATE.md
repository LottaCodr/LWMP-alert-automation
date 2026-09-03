## What does this change?

<!-- One or two sentences. Link the issue if there is one. -->

## Why is it needed?

<!-- The problem, not the implementation. -->

## How was it verified?

<!--
Paste the real output, not "tests pass". At minimum:

    npm run check

For anything touching delivery, RBAC, sessions or migrations, also say which
part of `npm run smoke:postgres` exercises it, or what you ran by hand and what
came back.
-->

## Checklist

- [ ] `npm run check` passes locally (typecheck, lint, unit tests, smoke test).
- [ ] No type errors were suppressed; no new `any`.
- [ ] New/changed domain rules have unit tests in `server/domain/__tests__/`.
- [ ] Any new screen implements loading, populated, empty and error states.
- [ ] No hard-coded colours/spacing — design tokens only (contrast tests pass).
- [ ] No phone number, code, secret or real member data in the diff or logs.
- [ ] New environment variables are in `server/config.ts` **and** `.env.example`.
- [ ] Database changes are a new numbered migration; no applied migration was edited.
- [ ] Role checks were updated on the server _and_ in `capabilitiesFor` if permissions changed.
- [ ] Docs updated if behaviour, configuration or hosting changed.

## Anything a reviewer should worry about?

<!--
Migrations, secret rotation, provider onboarding, a dependency upgrade,
anything that changes what gets sent to a real phone. Write "no" if there isn't.
-->
