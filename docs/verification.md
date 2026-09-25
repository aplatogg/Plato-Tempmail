# Public source verification

Verified locally on 2026-09-25 with Node 26, npm 11 and locked dependencies:

| Check | Result |
|---|---|
| Biome formatting/lint | Pass |
| Application and test TypeScript | Pass |
| Unit tests | 443 passed |
| Generic password/bootstrap/preflight tooling | 22 passed |
| Browser E2E, desktop and mobile | 226 passed |
| Local Worker integration, desktop and mobile | 6 passed |
| Wrangler dry build | Pass |
| Production dependency audit | 0 reported vulnerabilities |

Total: **697 passing tests**. The first browser run caught an outdated logo-letter
assertion after rebranding; it was corrected and the full browser suite rerun.

Tests use synthetic users, passwords, mail and deployment identifiers. The checked-in
production template is intentionally rejected by offline preflight until configured.
No live deployment, production login or real SMTP delivery is claimed for this template.
