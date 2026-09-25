# Security

Do not post credentials, tokens, password verifiers, private mailbox contents or
database exports in public issues, pull requests or workflow logs.

Use GitHub's **Report a vulnerability** option under the repository Security tab
for a private report when available. Describe impact and reproduction using
synthetic accounts and data, not another user's mailbox.

The application enforces account permissions on the server. Owners can inspect
other accounts' mail read-only; Admin and Dev roles do not grant that access.
Role changes and password changes invalidate affected sessions. Protect Owner
credentials and keep Cloudflare permissions restricted to the required resources.

The checked-in configuration is intentionally non-deployable until personalized
in a private working copy. Test credentials are public synthetic fixtures, not
credentials for a hosted instance.
