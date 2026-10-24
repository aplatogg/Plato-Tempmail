# Contributing to Plato-Tempmail

Thanks for taking the time to contribute. This project is a self-hosted,
multi-user temporary mail application for Cloudflare Workers, D1 and Email
Routing.

## Before you start

- Open an issue for bugs or feature proposals; small fixes can go straight to a
  pull request.
- Never commit real credentials, account or database IDs, domain configuration,
  mailbox data, browser traces or backups.
- Report security issues through [SECURITY.md](SECURITY.md), not a public issue.

## Local setup

Requirements: Node.js **22+** and npm.

```sh
npm ci
npm run bootstrap:local
npm run db:local
npm run dev
```

Open **http://127.0.0.1:8787**. Local bootstrap writes an ignored `.dev.vars`
with the synthetic login **admin / admin**; use a different password in
production.

## Checks

Run the checks that match your change before opening a pull request:

```sh
npm run lint
npm run typecheck
npm test
npm run test:tooling
npm run test:e2e
npm run test:integration
npm run build
```

`test:e2e` needs Chromium once: `npx playwright install chromium`. Unit and
integration tests use synthetic accounts and ephemeral local databases; `build`
is a dry run, not a deployment.

## Pull requests

- Keep each pull request focused on one concern.
- Use conventional commit subjects: `fix:`, `feat:`, `docs:`, `test:`, `chore:`.
- Add or update tests when behavior changes.
- Describe what changed and how you verified it.
- Update documentation when user-facing behavior changes.

## Roles and compatibility

The Owner / Admin / Dev / Member model is part of the security boundary.
Changes to authorization, sessions, password reset or mail ingestion should
include tests for every role they affect.

## License

By contributing, you agree that your changes are provided under the repository's
existing terms. Third-party notices are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
