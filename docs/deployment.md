# Deploy Plato-Tempmail

Use your own Cloudflare account, active DNS zone and a dedicated D1 database.
The tracked `wrangler.jsonc` is a template, not production configuration.
Keep your configured deployment copy private and do not push real resource IDs.

## 1. Authenticate and provision

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create plato-tempmail-db
```

Confirm the selected account before proceeding. In your private copy of
`wrangler.jsonc`, replace the account placeholder and zero database UUID with
your new resource identifiers. Set your dashboard hostname in `routes`, the exact
HTTPS dashboard origin in `PUBLIC_ORIGIN`, and the receiving domain in `MAIL_DOMAIN`.
Keep the Worker/database names and `DB` binding as shipped. `example.com` values
must be replaced. Do not add passwords or password hashes under `vars`.

If your account has no Workers subdomain, register one in Cloudflare's dashboard;
scheduled triggers may require it even though this app disables workers.dev access.

## 2. Initialize the database and password

```sh
npm run preflight
npm run db:remote
```

Generate the Owner verifier from an interactive hidden-input prompt:

```sh
node scripts/password-hash.mjs
npx wrangler secret put AUTH_PASSWORD_HASH
```

The first command prints a password verifier; paste that verifier, not the
password, into Wrangler's secret prompt. Treat the verifier as sensitive and do
not save it in source or shared logs. The primary username is configured through
`ADMIN_USERNAME`. Local fixture credentials must not be reused in production.

## 3. Deploy and route inbound mail

```sh
npm run deploy
```

In Cloudflare Email Routing for your receiving domain:

1. Review existing mail-service records before switching providers.
2. Activate Email Routing and publish its required DNS records.
3. Configure the catch-all action to send to Worker `plato-tempmail`.
4. Log in, create an inbox, and send a real message from an external mailbox.
5. Confirm it arrives and can be opened in the dashboard.

Only allocated inbox addresses receive messages. Local MIME fixture tests do not
verify DNS propagation or external SMTP delivery. Hourly cleanup removes expired
messages according to the seven-day retention setting.

## Updates and backups

Back up D1 privately before applying migrations. Exports can contain password
verifiers, sessions and mail; restrict permissions and never upload them here.
Wrangler exports may print a temporary signed download URL: keep export output private.

Apply all six numbered migrations in order. The role migration defaults existing
users to Member, preserves their password/inbox ownership and adds role-change
session revocation. Stored-user sessions from a pre-role version require a new login.

The offline preflight checks configuration shape, not account ownership or live
secrets. When migrating from another database, optionally supply previous UUIDs
with `node scripts/preflight.mjs --old-db-id UUID` to reject reuse locally.

Brand-specific cookies and principal headers are part of the client/server contract.
Deploy matching assets and Worker code together; existing sessions from differently
branded builds are not portable. Do not point this example config at an unrelated
production application.
