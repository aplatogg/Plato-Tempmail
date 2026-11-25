# Recovery runbook

Everything the application needs lives in three places: this repository, the D1
database, and the Cloudflare account. The domain is the only piece that cannot
be backed up.

## What a backup contains

| Item | Where | Recoverable |
|---|---|---|
| Source, assets, fonts, migrations | `backups/full-*/source.zip` and git | yes |
| Database (users, inboxes, messages, credentials, audit) | `backups/full-*/d1-plato.sql` | yes |
| Wrangler config (account id, D1 id, vars) | repository `wrangler.jsonc` | yes |
| Worker secret `AUTH_PASSWORD_HASH` | Cloudflare only | re-create (see below) |
| Custom domain, DNS, Email Routing rules | Cloudflare zone | re-create |
| The domain name itself | registrar | **no** |
| Attachment bytes | never stored | **no** |
| Mail older than retention (7 days) | deleted by cron | **no** |

Backups contain password verifiers, sessions and private mail. Keep them
private; `backups/` is gitignored on purpose.

## Create a backup

```sh
export CLOUDFLARE_API_TOKEN=...        # Workers Scripts + D1 edit
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler d1 export DB --remote --output backups/full-$(date +%Y%m%d-%H%M%S)/d1-plato.sql
```

Then zip the working tree (or simply commit and push). Verify a dump before
trusting it:

```sh
python -c "import sqlite3;c=sqlite3.connect('/tmp/t.sqlite');c.executescript(open('dump.sql').read());print(c.execute('pragma integrity_check').fetchone())"
```

## Restore: domain suspended, Cloudflare account intact

1. Add the new domain to Cloudflare and point its nameservers there.
2. Edit `wrangler.jsonc`:
   - `routes[0].pattern` -> `mail.newdomain.com`
   - `vars.MAIL_DOMAIN` -> `newdomain.com`
   - `vars.PUBLIC_ORIGIN` -> `https://mail.newdomain.com`
3. `npm run deploy`.
4. Email Routing on the new zone: enable, publish MX/SPF, set the catch-all
   action to the `plato-tempmail` Worker, add a DMARC record.
5. Verify with an external sender.

Existing inboxes and messages stay in D1. Their addresses keep the old domain
and stop receiving; new inboxes use the new domain. No data is lost.

## Restore: Cloudflare account lost

1. New account, new API token with Workers Scripts, D1, DNS, Email Routing.
2. `npx wrangler d1 create plato-tempmail-db` and put the new id plus the new
   `account_id` in `wrangler.jsonc`.
3. Import the dump:
   `npx wrangler d1 execute DB --remote --file backups/full-*/d1-plato.sql`
4. Create a new owner secret:
   `node scripts/password-hash.mjs` then `npx wrangler secret put AUTH_PASSWORD_HASH`.
   The restored `app_credentials` row keeps the old fingerprint, so the app
   falls back to the new secret: the owner password becomes the one you just
   hashed. Member passwords keep working because they live in the dump.
5. Deploy, attach the domain, configure Email Routing.
6. Re-add `RESET_EMAIL_TO` as a verified Email Routing destination.

## Restore: Worker deleted only

`npm run deploy` and re-put the secret. D1 is untouched.

## Domain-loss checklist

- Keep a second domain registered and already added to Cloudflare, so migration
  is a config change rather than a purchase.
- Monitor the Cloudflare abuse mailbox and reply to complaints.
- Keep DMARC at `p=quarantine` or stricter; a clean sending reputation makes
  suspensions less likely.
- Do not open public registration; accounts stay admin-created.
- Add per-user inbox quotas so one account cannot turn the domain into a spam
  magnet.
- Keep the retention window short (7 days) so little data is exposed.
- Export D1 at least daily; Cloudflare Time Travel only covers 30 days and is
  unavailable if the account itself is suspended.

## Secrets that must be re-created, never restored

`AUTH_PASSWORD_HASH` is not exportable. After any restore, put a fresh verifier
and use that password to sign in. Never store the verifier in the repository.

## Cloudflare configuration snapshot

`cloudflare-snapshot.json` in the backup folder records what lives in the zone,
not in the repository:

- zone identity and nameservers, plus every zone setting
- all DNS records: MX, SPF, DKIM (`cf2024-1._domainkey`), DMARC, custom-domain AAAA
- Email Routing catch-all (worker `plato-tempmail`) and the rule list
- Worker bindings (names only), cron schedule and custom domain

It does **not** contain secret values. `AUTH_PASSWORD_HASH` is listed by name
only and must be re-created.

Restoring DNS records after a zone loss:

```sh
# for each record in cloudflare-snapshot.json dnsRecords
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"MX","name":"example.com","content":"route1.mx.cloudflare.net","priority":10}'
```

Then re-enable Email Routing (it recreates MX/SPF if missing), set the catch-all
action to the worker, attach the custom domain by deploying, and re-put the
secret. Re-add and re-verify the `send_email` destination address; that
verification is account-scoped and cannot be exported.
