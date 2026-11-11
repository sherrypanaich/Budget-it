# Security

Budget it holds bank balances, transactions and bank connections for real people, so security reports matter.

Please don't open a public issue for a security problem. Use **Security > Report a vulnerability** on this repo instead, which reaches the maintainers privately. We'll reply within a week.

## What Budget it protects

- **Bank connections.** Plaid access tokens are encrypted with AES-256-GCM before they're saved. The key is `BUDGET_IT_KEY` if set, otherwise `data/secret.key` (created with permissions 600). Tokens are never sent to the browser or to an AI assistant.
- **Bank passwords.** Budget it never sees them. People sign in to their bank inside Plaid Link.
- **Read only.** Budget it only asks Plaid for transactions and balances. It has no way to move money.
- **Sign-ins.** Invite only. Passwords use scrypt. 5 wrong tries from one address pause sign-in there for 15 minutes, and 10 wrong tries on one account pause that account from anywhere. Session cookies are HttpOnly and SameSite. Changing or resetting a password ends that person's other sessions and live connections at once.
- **Sign-in code.** Optional second step (TOTP, RFC 6238) with 8 single-use backup codes. A code can't be used twice, and a password reset doesn't skip it.
- **The owner's page.** Whoever runs Budget it can manage people and backups. Its endpoints return no accounts, transactions or budgets.
- **Backups.** A backup can be locked with a passphrase: AES-256-GCM with a key from scrypt. With `BACKUP_PASSPHRASE` set, every copy written to `BACKUP_COPY_DIR` is locked, and written with permissions 600.
- **Laptop commands.** `node server.js ...` talks to the running app through a door that only answers on this computer, with a secret kept in `data/server.lock` (permissions 600), and never through a proxy or tunnel.
- **Privacy between people.** Each person's budget is private. Only accounts someone marks as shared are visible to the rest of the household, read only.
- **Receipt photos.** Saved in `data/receipts/` with permissions 600 and random names, and only served to the person who added them.
- **Split it.** The Split it key someone pastes in is encrypted like a bank connection and is only used to add expenses as that person.
- **The page.** A strict Content Security Policy allows scripts only from the laptop and Plaid.

## What you should do

- Keep `budget-it.env` (your Plaid keys) and `data/` private. Never commit them or paste them into a chat.
- A backup contains `secret.key`, which unlocks your bank connections. Lock backups with a passphrase (`BACKUP_PASSPHRASE`, or the question when you download one), and store a plain zip like a password.
- Turn on a sign-in code once the app can be reached from outside your home.
- Reach the app over https (Tailscale Funnel in the README does this for you).
- If you think a key leaked, rotate the secret in the Plaid dashboard, then disconnect and reconnect your banks.

## Supported versions

Only the newest release gets security fixes.
