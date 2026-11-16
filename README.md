# Haldgoff-Mail

Self-hosted, multi-user temporary email on **Cloudflare Workers, D1 and Email Routing**.
Private inboxes, a responsive web dashboard, and selectable **Celestial / Cosmos / Astral / Voyager / Stardust / Quark** roles.

> **Cloudflare and your own domain are required for real incoming email.**
> You need a Cloudflare account and a domain whose DNS is managed by Cloudflare.
> Downloading this repository does not activate an email service. Local mode is
> for trying the application; follow the [deployment guide](docs/deployment.md)
> to configure Workers, D1, DNS and Email Routing for your own instance.

This repository contains application source and synthetic tests, not a hosted public
mail service. All domains and deployment identifiers in the default configuration
are placeholders. No production credentials, mailbox data or operational backups
are included.

## Features

- Multiple roles per account: checkbox selections combine permissions.
- Celestial account management and read-only inspection of other users' inboxes.
- Cosmos management restricted to Quark/Voyager/Astral accounts; no cross-account mail access.
- Astral diagnostics containing only non-secret configuration and aggregate counts.
- Private inbox ownership, custom/random addresses, favorites, unread state and search.
- Plain-text mail rendering, OTP candidates, pagination and seven-day message retention.
- HTTP-only sessions, server-side authorization and session revocation on role/password changes.
- Desktop/mobile layouts, keyboard dialogs, themes and optional browser notifications.

## Roles

| Role | Access |
|---|---|
| Quark | One inbox named after the username; cannot create or delete inboxes |
| Voyager | Own inboxes and messages; up to 6 inboxes; cannot delete inboxes |
| Stardust | Up to 100 new inboxes per calendar year; cannot delete inboxes |
| Astral | Own mail, unlimited inboxes, inbox deletion, and read-only technical diagnostics |
| Cosmos | Own mail, unlimited inboxes and inbox deletion; create, reset and assign Quark/Voyager/Stardust/Astral accounts only |
| Celestial | All role assignments, unlimited inboxes and inbox deletion; manage accounts; inspect other mail read-only |

Every account can change its own password. Select at least one role in **Kelola
pengguna**; new accounts default to Voyager. Quark must be selected alone
and receives `username@domain` automatically. Role changes require the affected user
to log in again. The primary Celestial identity cannot be reset or demoted through
account-management controls. Additional Celestials remain independent accounts.

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
Email Routing setup. Copy the tracked `wrangler.jsonc` template to the ignored
`wrangler.local.jsonc`, fill that private copy, and run the provided scripts.
Production commands run an offline preflight that rejects the unconfigured template. A successful deploy does not prove inbound delivery;
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

## API for automation

`/api/v1/*` is a REST surface for bots and scripts, authenticated with an API key
instead of a cookie. Create a key in the app (top-right **API** button) and send it
as `Authorization: Bearer hvk_...`. Full endpoint list in [`docs/API.md`](docs/API.md).

Voyager and Quark accounts cannot hold keys (`403 API_KEY_FORBIDDEN`).

## Retention and plans

| Plan | Role mask | Message retention | API key |
|---|---|---|---|
| Celestial | 8 | 30 days | yes |
| Cosmos | 4 | 30 days | yes |
| Astral | 2 | 30 days | yes |
| Stardust | 32 | 14 days | yes |
| Voyager | 1 | 7 days | no |
| Quark | 16 | 7 days | no |

Retention is resolved from the inbox owner's role when a message arrives; the
highest role wins on a multi-role account.
