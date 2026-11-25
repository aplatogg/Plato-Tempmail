# Security

Do not post credentials, tokens, password verifiers, private mailbox contents or
database exports in public issues, pull requests or workflow logs.

Use GitHub's **Report a vulnerability** option under the repository Security tab
for a private report when available. Describe impact and reproduction using
synthetic accounts and data, not another user's mailbox.

The application enforces account permissions on the server. Celestial accounts can inspect
other accounts' mail read-only; Cosmos and Astral roles do not grant that access.
Role changes and password changes invalidate affected sessions. Protect Celestial
credentials and keep Cloudflare permissions restricted to the required resources.

The checked-in configuration is intentionally non-deployable until personalized
in a private working copy. Test credentials are public synthetic fixtures, not
credentials for a hosted instance. Keep the real `wrangler.local.jsonc` and any
D1 exports under `backups/` out of source control and shared archives; exports
contain mailbox data and should be encrypted or deleted when no longer needed.

Webhook delivery rejects literal private and local targets and does not follow
redirects. DNS rebinding through a public hostname can still resolve privately;
use an explicit webhook allowlist or an egress proxy when that threat is in scope.
