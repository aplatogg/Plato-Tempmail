# Plato-Tempmail

Self-hosted, multi-user temporary email on **Cloudflare Workers, D1 and Email Routing**.
Private inboxes, a responsive web dashboard, and selectable **Owner / Admin / Dev / Member** roles.

This repository contains application source and synthetic tests, not a hosted public
mail service. All domains and deployment identifiers in the default configuration
are placeholders. No production credentials, mailbox data or operational backups
are included.

## Features

- Multiple roles per account: checkbox selections combine permissions.
- Owner account management and read-only inspection of other users' inboxes.
- Admin management restricted to Member/Dev accounts; no cross-account mail access.
- Dev diagnostics containing only non-secret configuration and aggregate counts.
- Private inbox ownership, custom/random addresses, favorites, unread state and search.
- Plain-text mail rendering, OTP candidates, pagination and seven-day message retention.
- HTTP-only sessions, server-side authorization and session revocation on role/password changes.
- Desktop/mobile layouts, keyboard dialogs, themes and optional browser notifications.

## Roles

| Role | Access |
|---|---|
| Member | Own inboxes and messages |
| Dev | Own mail plus read-only technical diagnostics |
| Admin | Own mail; create, reset and assign Member/Dev accounts only |
| Owner | All role assignments; manage additional accounts; inspect other mail read-only |

Every account can change its own password. Select at least one role in **Kelola
pengguna**; new accounts default to Member. Role changes require the affected user
to log in again. The primary Owner identity cannot be reset or demoted through
account-management controls. Additional Owners remain independent accounts.

## Run locally

Requirements: Node.js **22+**, npm, and the pinned dependencies.

```sh
npm ci
npm run bootstrap:local
npm run db:local
npm run dev
```

Open **http://127.0.0.1:8787**. Local bootstrap creates ignored `.dev.vars` with
the synthetic login **admin / admin**. It refuses to overwrite an existing file.
Use a separate production password; the application accepts 5–1024 UTF-16 units.
Local mode does not receive Internet email automatically.

## Deploy your own instance

See **[Deployment](docs/deployment.md)** for account, domain, database, secret and
Email Routing setup. Production commands run an offline preflight that rejects
the unconfigured template. A successful deploy does not prove inbound delivery;
verify it with an external sender after DNS and routing are active.

## Verify

```sh
npm run lint
npm run typecheck
npm run test:tooling
npm test
npx playwright install chromium
npm run test:e2e
npm run test:integration
npm run build
```

Unit/integration tests use synthetic accounts and ephemeral local databases.
Browser tests cover desktop and mobile. `build` is a dry run, not a deployment.

## Privacy and security

- Never commit `.env`, `.dev.vars`, OAuth profiles, API keys, password hashes,
  database exports, browser traces, screenshots of private data or private logs.
- Keep real account/database IDs and domain configuration in a private working copy.
- The default repository configuration must remain a placeholder template.
- Public source does not imply anonymous access to an instance; authentication is required.
- See **[Security](SECURITY.md)** before reporting a vulnerability.

Third-party copyright and license notices are retained in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Making this repository public
does not grant an additional license to the original application code.
