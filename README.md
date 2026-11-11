# Budget it

**Your whole money picture, on a laptop you already own.** A free, open source [Budget It](https://budgetit.ca/) project, alongside [Split it](https://github.com/sherrypanaich/split-it).

Budget it brings your bank accounts together, sorts your spending, and keeps a monthly budget for each kind of spending: groceries, dining out, home and bills, and so on. It finds your bills and subscriptions, tracks savings goals, and nudges your phone before a budget runs out. Your budget is stored on your own machine, with no ads and no tracking. Banks connect through [Plaid](https://plaid.com), read only. "Where your data goes" below says exactly who sees what.

- Website: https://budgetit.ca/
- Support it: https://github.com/sponsors/sherrypanaich
- Licence: MIT (see `LICENSE`). Character art is not covered by the licence, see "Character art" below.
- What's new: `CHANGELOG.md`

What's in this repo:

- `server.js` runs the app. No npm packages to install, just Node.js 22 or newer.
- `plaid.js` talks to Plaid. `budget.js` and `ops.js` are the money rules, shared by the server and the page.
- `accounts.js` (sign-in) and `push.js` (phone notifications) are the same files Split it uses, word for word.
- `public/` is the app page and sign-in pages.
- `docs/` is the website at budgetit.ca, served by GitHub Pages.
- `data/` is created on first run and never committed. It holds `db.json` (budgets, transactions and encrypted bank connections), `users.json` (sign-ins), `secret.key` (unlocks the bank connections), `oauth.json` (AI assistants), `push.json` and `push-keys.json` (phone notifications), `receipts/`, and `backups/` (a copy of `db.json` every day for 30 days, and every Sunday for a year).
- `test/` checks the money rules and runs the whole server against a stand-in Plaid. `node --test test/*.test.js` runs it; `install.sh` runs it for you.
- `Dockerfile` and `compose.yaml` if you'd rather run it in a container (`docker compose up -d`, then `docker compose exec budget-it node server.js add-user YOU`). The app runs as an ordinary user inside the container, not root.

## Quick install

On a Linux machine (Ubuntu, Mint, Debian and similar):

```
git clone https://github.com/sherrypanaich/budget-it
cd budget-it
bash install.sh
```

It installs Node.js if needed, copies the app to `~/budget-it`, and starts it on boot at port 8090 (Split it uses 8080, so both can run on the same laptop). Then do steps 3 and 4 below. Running it again later (after `git pull`) updates the app and keeps your data and settings.

## 1. Install Node.js (once)

```
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Node 22 or newer works. Older ones no longer get security fixes.

## 2. Put the app in your home folder

Copy this folder to `~/budget-it`. `install.sh` does this for you.

## 3. Add yourself

```
cd ~/budget-it
node server.js add-user Sherry
```

The first person added runs it: they get a page for people, backups and health (Settings, People, backups and health). Open http://localhost:8090 and sign in. To look around before connecting a bank, tap "look around with sample data" on Home (or run `node server.js sample Sherry`). Settings, Remove sample data takes it out again.

Everyone else joins with an invite: Settings, Invite someone gives you a link that works once, for 7 days. Each person gets their own private budget.

## 4. Connect your banks with Plaid

Budget it uses your own Plaid account, so your bank data goes from Plaid straight to your laptop.

**Start in test mode.** It costs nothing and uses a made-up bank.

1. Sign up at https://dashboard.plaid.com/signup.
2. In the dashboard, go to **Developers > Keys**. Copy the **client_id** and the **Sandbox** secret.
3. On the laptop, open `~/budget-it/budget-it.env` (install.sh made it) and fill in:
   ```
   PLAID_CLIENT_ID=your client_id
   PLAID_SECRET=your sandbox secret
   PLAID_ENV=sandbox
   ```
4. `systemctl --user restart budget-it`
5. In the app, go to Accounts, Connect a bank. Pick any bank and sign in with `user_good` and `pass_good`. Plaid's test bank comes in with a few months of made-up transactions.

Keep these keys on the laptop. Don't paste them into a chat, an email or GitHub.

**Then your real banks.** New Plaid accounts in Canada and the US start on Plaid's free Trial plan, which works with real banks.

1. In the Plaid dashboard, copy the **Production** secret from **Developers > Keys**. If the dashboard asks you to finish your profile or answer a few questions first, do that.
2. In `budget-it.env`, put it in `PLAID_SECRET` and set `PLAID_ENV=production`. Restart.
3. Connect your banks in the app. Budget it covers Canada and the US by default (`PLAID_COUNTRIES=CA,US`).

Three things to know about the free plan:

- **It allows 10 bank connections, for everyone on the laptop together.** Each bank a person connects uses one. The Connect a bank screen and the owner's page show how many are used.
- **Disconnecting a bank does not give its connection back.** If a bank stops updating, use Reconnect on it. Don't remove it and add it again, because that uses another one.
- **If you need more than 10,** switch to pay as you go in the Plaid dashboard (Plaid then charges per connected bank), and set `PLAID_ITEM_LIMIT=0` in `budget-it.env` so the app stops counting.

Plaid changes its plans from time to time. The dashboard always shows what yours includes.

**Banks that send you to their own app.** Some banks approve the connection in their own app or website and then need an address to send you back to. Plaid only accepts an https address it knows about:

1. Do step 6 first, so Budget it has an https address.
2. In `budget-it.env`, set `PLAID_REDIRECT_URI` to that address followed by `/plaid/return`, like `https://your-laptop.tail1234.ts.net/plaid/return`.
3. In the Plaid dashboard, add the same address under **Developers > API > Allowed redirect URIs**.
4. Restart. Open Budget it at that https address when you connect the bank.

New transactions come in every 6 hours (`SYNC_HOURS`), and whenever you tap Update on the Accounts page. If a bank asks you to sign in again, Home shows "needs you" and a Reconnect button.

**Banks Plaid can't reach:** download a CSV from your bank's website and use Import a CSV. It understands most bank exports and skips rows it already has. Or add the account by hand and keep its balance up to date.

## 5. Start it automatically when the laptop turns on

`install.sh` sets this up. To do it by hand:

```
mkdir -p ~/.config/systemd/user
cp ~/budget-it/budget-it.service ~/.config/systemd/user/
systemctl --user enable --now budget-it
sudo loginctl enable-linger $USER
```

## 6. Reach it from anywhere (free)

This uses Tailscale Funnel, which gives the app a private https web address without opening anything on your router.

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale funnel --bg 8090
```

If Split it already uses Funnel on this laptop, give Budget it its own https port instead: `sudo tailscale funnel --bg --https=8443 8090`, and open `https://your-laptop.tail1234.ts.net:8443`.

Put that address in `budget-it.env` as `PUBLIC_URL`, then restart. On iPhone, Share then "Add to Home Screen" makes it feel like an app.

Once it can be reached from outside your home, turn on a sign-in code (next section).

## Your sign-in

Settings, Your sign-in. Change your password, add an email, connect Google, or sign out on all devices.

**Sign-in code.** A second step after your password: a 6-digit code from an authenticator app such as Google Authenticator, 1Password or Apple Passwords. Turn it on there, then save the 8 backup codes it shows. Each backup code works once, for the day you don't have your phone. A password reset link does not skip the code. If someone loses both their phone and their backup codes, whoever runs Budget it can turn their code off (on the owner's page, or `node server.js code-off NAME`).

Changing or resetting a password signs out your other phones straight away. A reset, and "Sign out on all devices", also disconnect any AI assistant.

Sign-in by email and "Continue with Google" work the same as in Split it: fill in the matching lines in `budget-it.env`.

## The page for whoever runs it

Settings, People, backups and health. Only people who run this Budget it see it.

- **Health:** the version, how long it has been running, free disk space, the last backup, the copy off the laptop, and how many bank connections are used. It tells you when a newer Budget it is out (it asks GitHub for the newest version number and sends nothing about you; `UPDATE_CHECK=off` stops that).
- **People:** who is here, when they last opened it, and whether they have a sign-in code. Tap someone to make a reset link, change their sign-in name, sign them out everywhere, turn off their sign-in code, let them run it too, or remove them.
- **Backups:** download one, restore one, or copy one off the laptop now.

This page never shows anyone's accounts, charges or budgets. Each person's budget stays private from the others, including from whoever runs it. (Whoever has the laptop itself can read the files on it, so pick someone the household trusts.)

## Backups

The laptop keeps a copy of your data every day for 30 days and every Sunday for a year, in `data/backups/`. Those sit on the same disk as the app, so a dead disk takes them too.

**A copy that survives the laptop.** Set `BACKUP_COPY_DIR` in `budget-it.env` to a folder somewhere else: a USB drive that stays plugged in, or a folder that Dropbox, Syncthing or Nextcloud sends off the laptop. Once a day a full backup goes there, and the newest 14 are kept. The owner's page warns you when no second place is set, when a copy fails (drive unplugged), and when the newest copy is more than 3 days old.

**Lock it.** A backup holds everyone's budgets, receipt photos, sign-ins, and `secret.key`, which unlocks the bank connections. Set `BACKUP_PASSPHRASE` in `budget-it.env` and every copy off the laptop is locked with it (AES-256-GCM, files ending in `.locked`). Without the passphrase a locked backup can't be read by anyone, including you, so write it down somewhere that isn't the laptop.

**By hand.** On the owner's page, Download a backup asks for a passphrase and gives you a locked file. From the terminal:

```
node server.js backup ~/budget-it-backup.locked
```

It asks for a passphrase (or uses `BACKUP_PASSPHRASE`). Press Enter at the question for a plain zip instead.

**Restore.** On the owner's page, Restore a backup takes a locked backup or a plain zip. What was there before is kept in `data/backups/` first (files starting with `before-restore-`), and everyone stays signed in. From the terminal, with the app stopped: `node server.js restore FILE`.

To get your transactions into a spreadsheet: Settings, Export transactions.

## Phone notifications

Settings, Phone notifications. You get one when a budget reaches 80%, one if it goes over, one the evening before a bill is due, heads-ups about unusual charges and price increases, and a Sunday check-in. On iPhone, add Budget it to your Home Screen first.

## Use it from Claude or Muse (or another AI assistant)

Budget it has a connector (`mcp.js`) so an assistant can answer questions about your money and make small changes by chat. It needs the https address from step 6. Budget it has no AI built in: nothing is sent to an AI company unless you connect an assistant yourself.

Add a custom connector (remote MCP server, streamable HTTP) at `https://YOUR-ADDRESS/mcp`. It signs in with OAuth: the assistant sends you a link, and you sign in with your Budget it name and password (and your sign-in code, if you turned one on). It then acts as you.

It can: show balances and net worth, find transactions (including by #tag), summarise spending for a month, report on how a month went, review a whole year, list what investment accounts hold, work out how long a card or loan takes to pay off, show what's left in each budget, say what's safe to spend until payday, list bills and subscriptions, list goals, change a category (and make a rule), add a cash purchase, set a budget, create a goal, add savings to a goal, ask the banks for new transactions, and undo its last change. It can't move money and never sees bank passwords or Plaid keys.

If the assistant wants a key instead: `node server.js mcp-key Sherry` prints one (a "Bearer" token). `node server.js mcp-revoke Sherry` signs out every assistant for that person.

**Find it in the MCP registry:** the app is listed in the official [MCP registry](https://registry.modelcontextprotocol.io) as `io.github.sherrypanaich/budget-it` (see `server.json`). Assistants that read the registry ask for your address and connect to `https://YOUR-ADDRESS/mcp`. To update the listing after a release, bump `version` in `server.json` and run **List in the MCP registry** from the Actions tab.

## Send charges to Split it

If you also run [Split it](https://github.com/sherrypanaich/split-it), Budget it can add a charge there as a shared expense.

1. In Split it's folder, make a key for yourself: `node server.js mcp-key YOURNAME`
2. In Budget it: Settings, Split it. Paste Split it's address (for example `http://localhost:8080`) and the key.
3. Tap any charge, then Split it with someone, and pick the group.

**Count only my share in my budget** is ticked by default. When you pay $90 for groceries for three people, $30 stays in your Groceries budget and the other $60 becomes its own line, "Owed back by housemates", which doesn't count as spending. Untick it to keep the whole amount in your budget.

The key is encrypted on the laptop. Each person connects their own Split it account.

## Where your data goes

Your budget lives in `data/` on your laptop. Budget it has no server of its own anywhere else, no ads and no tracking. These are the only times anything leaves the laptop:

- **Plaid.** Plaid connects to your bank, so Plaid sees your balances and transactions. That is how the data reaches your laptop. Plaid's privacy policy covers what it does with it.
- **An AI assistant, if you connect one.** It sees what it asks for (balances, transactions, budgets), and so does the company that makes it.
- **Email and Google sign-in, if you set them up.** Resend delivers the sign-in emails. Google confirms who you are.
- **Phone notifications.** The words of a notification pass through Apple's or Google's push service, encrypted so only your phone can read them.
- **Today's rates.** Tapping Get today's rates asks the Bank of Canada (CAD homes) or frankfurter.app (other home currencies, the European Central Bank's rates) for exchange rates. Only the currency codes are sent.
- **Fonts and Plaid's sign-in window** load from Google Fonts and Plaid when you open the page.
- **The update check.** The owner's page asks GitHub for the newest version number.

## Other handy bits

- `node server.js list-users`, `set-password NAME`, `remove-user NAME` (also disconnects their banks), `code-off NAME`. These work while the app is running and take effect right away. No restart needed.
- Rules: tick "Always put it here" when you change a category. Budgets, Rules lists and removes them.
- Share an account: open it on the Accounts page and tick "Share with the household". Others see it, read only, and it doesn't count toward their budgets.
- Other currencies: totals are in CAD unless you change it in Settings, Currencies. Get today's rates works for any home currency.

## Character art

The guide characters in `public/art/` are not covered by the MIT licence and may not be reused. If you own something shown here and want it removed, [open an issue](https://github.com/sherrypanaich/budget-it/issues/new) and we'll take it down.

## Made with AI

AI tools were used to help build this project, including its code and artwork.
