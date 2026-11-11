# Budget it

**Your whole money picture, on a laptop you already own.** A free, open source [Budget It](https://budgetit.ca/) project, alongside [Split it](https://github.com/sherrypanaich/split-it).

Budget it brings your bank accounts together, sorts your spending, and keeps a monthly budget for each kind of spending: groceries, dining out, home and bills, and so on. It finds your bills and subscriptions, tracks savings goals, and nudges your phone before a budget runs out. Your budget is stored on your own machine, with no ads and no tracking. Start with a CSV from your bank's website or accounts you keep by hand; if you have [Plaid](https://plaid.com) keys, banks can also connect by themselves, read only. "Where your data goes" below says exactly who sees what.

- Website: https://budgetit.ca/
- Support it: https://github.com/sponsors/sherrypanaich. Running Budget it and Split it together costs about $70 a month. Linking bank accounts costs extra on top of that, because Plaid charges for bank connections.
- Licence: MIT (see `LICENSE`). Character art is not covered by the licence, see "Character art" below.
- What's new: `CHANGELOG.md`

What's in this repo:

- `server.js` runs the app. No npm packages to install, just Node.js 22 or newer.
- `plaid.js` talks to Plaid. `budget.js` and `ops.js` are the money rules, shared by the server and the page.
- `accounts.js` (sign-in) and `push.js` (phone notifications) are the same files Split it uses, word for word.
- `public/` is the app page and sign-in pages.
- `docs/` is the website at budgetit.ca, served by GitHub Pages.
- `data/` is created on first run and never committed. It holds `db.json` (budgets, transactions and encrypted bank connections), `users.json` (sign-ins), `secret.key` (unlocks the bank connections), `oauth.json` (AI assistants), `push.json` and `push-keys.json` (phone notifications), `receipts/`, and `backups/` (copies of `db.json`: one at every start, one every 6 hours for two days, one a day for 30 days, and one every Sunday for a year).
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

The first person added runs it: they get a page for people, backups and health (Settings, People, backups and health). Open http://localhost:8090 and sign in. To look around first, tap "look around with sample data" on Home (or run `node server.js sample Sherry`). Settings, Remove sample data takes it out again.

Everyone else joins with an invite: Settings, People and friends, Make an invite link gives you a link that works once, for 7 days. Each person gets their own private budget, and you're friends right away. Your open invite links are listed there too, with Cancel.

**Finding people already on Budget it.** Everyone has a unique tag, like `@sam`, which they can change in Settings, People and friends. Type someone's exact tag (or the email they checked on their account) and they get a friend request to accept. There's also your friend link, with a QR code: anyone here who opens it becomes your friend right away, and Make a new link turns the old one off. Being friends shares nothing by itself; it just puts those people first when you pick who can see an account.

## 4. Bring in your accounts

**Start with a CSV, or by hand.** Most people running this won't have Plaid keys, and you don't need them. On the Accounts page:

- **Import a CSV.** Download your transactions from your bank's website and pick the file. Budget it understands most bank exports, shows you a preview first, and skips rows it already has, so importing again next month is fine.
- **Add by hand.** Chequing, savings, a card, a loan or cash, with today's balance. Update the balance whenever you like, and add cash purchases with quick add ("lunch 14.20").

**Then, if you want, connect banks with Plaid.** Balances and charges come in by themselves, read only. Budget it uses your own Plaid account, so your bank data goes from Plaid straight to your laptop.

**Start in test mode, and stay there for a week.** It costs nothing and uses a made-up bank. Run Budget it on Sandbox for a week before you connect a real bank: see the updates come in, try Reconnect and Disconnect, and make sure your backups work. Real connections are limited (below), so it's worth getting comfortable first.

1. Sign up at https://dashboard.plaid.com/signup.
2. In the dashboard, go to **Developers > Keys**. Copy the **client_id** and the **Sandbox** secret.
3. On the laptop, open `~/budget-it/budget-it.env` (install.sh made it) and fill in:
   ```
   PLAID_CLIENT_ID=your client_id
   PLAID_SECRET=your sandbox secret
   PLAID_ENV=sandbox
   ```
4. `systemctl --user restart budget-it`
5. In the app, go to Accounts, Connect a bank. Pick any bank and sign in with `user_good` and `pass_good`. Plaid's test bank comes in with made-up transactions.

Keep these keys on the laptop. Don't paste them into a chat, an email or GitHub.

**Then your real banks.** New Plaid accounts in Canada and the US start on Plaid's free Trial plan, which works with real banks.

1. In the Plaid dashboard, copy the **Production** secret from **Developers > Keys**. If the dashboard asks you to finish your profile or answer a few questions first, do that.
2. In `budget-it.env`, put it in `PLAID_SECRET` and set `PLAID_ENV=production`. Restart.
3. Connect your banks in the app. Budget it covers Canada and the US by default (`PLAID_COUNTRIES=CA,US`). A new connection asks for up to two years of history; banks send what they have.

Three things to know about the free plan:

- **It allows 10 bank connections, for good, for everyone on the laptop together.** Each bank a person connects uses one. The Connect a bank screen and the owner's page show how many are used, and Budget it asks you to confirm before each new one ("This uses 1 of your 10 free bank connections; 7 left").
- **Disconnecting a bank does not give its connection back.** If a bank stops updating, use Reconnect on it. Don't remove it and add it again, because that uses another one.
- **Disconnecting keeps your history.** The connection is deleted here and at Plaid, but the accounts and transactions stay, marked "Disconnected · history kept", with your categories, notes and splits. If you connect that bank again, its accounts carry on from the old ones without doubling anything. To really get rid of one, open the account and tap Delete this history.
- **If you need more than 10,** switch to pay as you go in the Plaid dashboard (Plaid then charges per connected bank), and set `PLAID_ITEM_LIMIT=0` in `budget-it.env` so the app stops counting.

Plaid changes its plans from time to time. The dashboard always shows what yours includes.

**Banks that send you to their own app (`PLAID_REDIRECT_URI`).** Some banks, including many big ones in Canada and the US, approve the connection in their own app or website and then need an address to send you back to. Without it, those banks can't connect. Plaid only accepts an https address that is registered in your Plaid dashboard:

1. Do step 6 first (or use your own tunnel), so Budget it has an https address.
2. In `budget-it.env`, set `PLAID_REDIRECT_URI` to that address followed by `/plaid/return`, like `https://your-laptop.tail1234.ts.net/plaid/return`.
3. In the Plaid dashboard, add exactly the same address under **Developers > API > Allowed redirect URIs**. If it isn't registered there, Plaid refuses to open.
4. Restart. Open Budget it at that https address when you connect the bank.

New transactions come in every 6 hours (`SYNC_HOURS`), and whenever you tap Update on the Accounts page. Each bank shows when it last updated. If a bank asks you to sign in again, your phone gets one notification, Home shows it under "Needs you", and Reconnect signs you back in to the same connection (it doesn't use another one).

**Banks Plaid can't reach:** use Import a CSV or Add by hand, as above.

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

### Running behind a proxy (Coolify, Traefik, Cloudflare tunnel)

If Budget it runs in Docker behind a proxy instead, these settings in `budget-it.env` (see `budget-it.env.example`) matter:

- **`PUBLIC_URL`**: the https address people open, like `https://budget.yourdomain.com`. Email links, Google sign-in and AI assistants use it, and Budget it accepts changes from a page at that address.
- **`TRUSTED_PROXY`**: every request reaches the app from the proxy (Traefik at `10.0.2.6`, say), so Budget it reads the visitor's own address from `CF-Connecting-IP` or `X-Forwarded-For`. It believes those only when the request came from a private, loopback or Docker address, which is where a proxy lives. That keeps the wrong-password limit per visitor, so one person's typos never lock everyone out. If your proxy has a public address, add it here (addresses or ranges, comma separated). Write `none` when nothing sits in front of Budget it. If you aren't behind Cloudflare, make sure your proxy doesn't pass on a `CF-Connecting-IP` that visitors send.
- **`TZ`**: your time zone, like `America/Toronto`. Containers run on UTC otherwise, so bill reminders would come at the wrong hour and "today" would flip over in the evening. `compose.yaml` sets it too: change it there.
- **`SPLIT_IT_URL`**: if Split it runs on the same laptop or network (`http://split-it:8080` in Docker), name it here. Budget it then only connects to that Split it. Without it, only a public https address works, so nobody can use the Split it setting to reach other things on your network.
- **Bind the port locally**: when the tunnel is the only way in, write `"127.0.0.1:8090:8090"` under `ports` in `compose.yaml`, so nobody on your Wi-Fi can go around the proxy. Coolify's Traefik reaches the container over Docker's own network, so it still works.

Changes (anything but reading) are only accepted from Budget it's own page: the address in `PUBLIC_URL`, or the one the proxy says was asked for (`Host` or `X-Forwarded-Host`). Traefik and Cloudflare normally pass that on; if yours doesn't, set `PUBLIC_URL`. Scripts and `curl`, which send no `Origin`, still work.

## Your sign-in

Settings, Your sign-in. Change your password, add an email, connect Google, or sign out on all devices.

**Sign-in code.** A second step after your password: a 6-digit code from an authenticator app such as Google Authenticator, 1Password or Apple Passwords. Turn it on there, then save the 8 backup codes it shows. Each backup code works once, for the day you don't have your phone. A password reset link does not skip the code. If someone loses both their phone and their backup codes, whoever runs Budget it can turn their code off (on the owner's page, or `node server.js code-off NAME`).

Changing your email asks for your current password (or a sign-in code), since an email can reset the password. A sign-in lasts 90 days from the last day you used it. Wrong passwords lock out the address they come from for 15 minutes; aimed at one account from many places, they only slow that account's sign-in down, so nobody can keep a housemate out by typing their name.

Changing or resetting a password signs out your other phones straight away. A reset, and "Sign out on all devices", also disconnect any AI assistant.

Sign-in by email and "Continue with Google" work the same as in Split it: fill in the matching lines in `budget-it.env`.

## The page for whoever runs it

Settings, People, backups and health. Only people who run this Budget it see it.

- **Health:** the version, how long it has been running, free disk space, the last backup, the copy off the laptop, and how many bank connections are used. It tells you when a newer Budget it is out (it asks GitHub for the newest version number and sends nothing about you; `UPDATE_CHECK=off` stops that).
- **People:** who is here, when they last opened it, and whether they have a sign-in code. Tap someone to make a reset link, change their sign-in name, sign them out everywhere, turn off their sign-in code, let them run it too, or remove them.
- **Backups:** download one, restore one, or copy one off the laptop now.

This page never shows anyone's accounts, charges or budgets. Each person's budget stays private from the others, including from whoever runs it in the app.

**What the person with the laptop can see.** Whoever runs the laptop itself (or can sign in to it, or holds an unlocked backup) can read everything: every budget, transaction, note and receipt photo, including the private ones, and with `secret.key` they can use the bank connections. The app keeps people's budgets apart from each other; it can't keep them from the person who has the files. Pick someone the household trusts, and tell everyone who it is.

Anyone can take their own data with them, or remove it: Settings, Your data has Download my data (a file with your own budget, transactions and the list of your receipt photos, nothing of anyone else's) and Delete my data (your budget, receipt photos, bank connections and account, after you type your name). The only person who runs it can't delete themselves that way: make someone else the owner first. Older backups on the laptop keep a copy until they're replaced.

## Backups

The laptop keeps copies of your budgets in `data/backups/`: one each time the app starts (the last 5, which covers every update), one every 6 hours (the last 8), one a day for 30 days and one every Sunday for a year. Those sit on the same disk as the app, so a dead disk takes them too. If `db.json` is ever damaged, Budget it starts from the newest good copy, keeps the damaged file next to it, and tells whoever runs it which copy it used and from when.

**A full disk.** When the laptop's disk is full, Budget it keeps running: a change that can't be saved gets "The laptop’s disk is full, so this wasn’t saved." and the owner's page says so. It warns from 90% full.

**A copy that survives the laptop.** Set `BACKUP_COPY_DIR` in `budget-it.env` to a folder somewhere else: a USB drive that stays plugged in, or a folder that Dropbox, Syncthing or Nextcloud sends off the laptop. Once a day a full backup goes there, and the newest 14 are kept. The owner's page warns you when no second place is set, when a copy fails (drive unplugged), and when the newest copy is more than 3 days old.

**Lock it.** A backup holds everyone's budgets, receipt photos, sign-ins, and `secret.key`, which unlocks the bank connections. Set `BACKUP_PASSPHRASE` in `budget-it.env` and every copy off the laptop is locked with it (AES-256-GCM, files ending in `.locked`). Without the passphrase a locked backup can't be read by anyone, including you, so write it down somewhere that isn't the laptop. Until you set one, the copies off the laptop leave out `secret.key` while any bank or Split it is connected, so a lost drive doesn't hand over the bank connections. Those copies restore on this laptop (its `data/secret.key` is still there); on a new laptop, copy the old `data/secret.key` across first.

If `secret.key` is ever damaged or can't be read while banks are connected, Budget it won't start (it says why) rather than make a new key and lose them. Put a good one back from a backup.

**By hand.** On the owner's page, Download a backup asks for a passphrase and gives you a locked file. From the terminal:

```
node server.js backup ~/budget-it-backup.locked
```

It asks for a passphrase (or uses `BACKUP_PASSPHRASE`). Press Enter at the question for a plain zip instead.

**Restore.** On the owner's page, Restore a backup takes a locked backup, a plain zip, or one of the `db-....json` copies from `data/backups/` (that puts back the budgets alone). Every file in it is checked first, and a file that isn't Budget it data changes nothing. What was there before is kept in `data/backups/` first (files starting with `before-restore-`), and everyone stays signed in.

### Restoring a backup from the terminal

Uploading through a Cloudflare tunnel stops at 100 MB on Cloudflare's free plan, and a backup with lots of receipt photos can be bigger. Restore it on the laptop instead:

1. Copy the backup file onto the laptop.
2. Stop the app: `systemctl --user stop budget-it` (with Docker: `docker compose stop`).
3. In the app's folder: `node server.js restore /path/to/budget-it-backup-2026-11-10.locked`. It asks for the passphrase if the file is locked (or uses `BACKUP_PASSPHRASE`). With Docker, put the file in the data volume and run it there: `docker cp budget-it-backup.locked budget-it:/data/`, then `docker compose run --rm budget-it node server.js restore /data/budget-it-backup.locked` (under Coolify, use the container name it shows).
4. Start the app again.

To get your transactions into a spreadsheet: Settings, Export transactions.

## Phone notifications

Settings, Phone notifications. You get one when a budget reaches 80%, one if it goes over, one the evening before a bill is due, heads-ups about unusual charges and price increases, and a Sunday check-in. On iPhone, add Budget it to your Home Screen first.

## Use it from Claude or Muse (or another AI assistant)

Budget it has a connector (`mcp.js`) so an assistant can answer questions about your money and make small changes by chat. It needs the https address from step 6. Budget it has no AI built in: nothing is sent to an AI company unless you connect an assistant yourself.

**The easy way:** everyone opens Settings in Budget it and taps **AI assistants**. It shows their own connector link, steps for Claude, every assistant connected as them, and buttons to make a key or disconnect one. Nobody needs the laptop for this.

**Connect Claude:** in Claude, open Settings, then Connectors, tap **Add custom connector**, name it Budget it and paste `https://YOUR-ADDRESS/mcp`. Tap Connect. Budget it's page says where the access goes ("Budget it sends access to: claude.ai"); check that, then tap Allow. Then turn it on in a chat's tools menu.

Other assistants: add a custom connector (remote MCP server, streamable HTTP) at `https://YOUR-ADDRESS/mcp`. It signs in with OAuth: the assistant sends you a link. If you're already signed in to Budget it in that browser, one tap on **Allow** connects it (this works for people who sign in with Google and have no password). Otherwise sign in with your Budget it name and password (and your sign-in code, if you turned one on). It then acts as you. The page warns you if the address it sends access to isn't https.

**Read only:** tick **Read only** on the Allow page, or when you make a key, and the assistant can look at your budget but not change anything. On the laptop: `node server.js mcp-key Sherry --read-only`.

**Keys and sign-ins expire when unused:** a key or an assistant nobody has used for 90 days stops working and is removed. Connect it again any time. Settings, AI assistants shows when each one was last used.

Assistants are told to check with you before they change anything, and that names and notes in quotes (from banks, or from people, like a Split it group) are data, not instructions. If an assistant sends the same purchase or goal twice within 2 minutes (say it retried after a slow reply), Budget it adds it once.

It can: show balances and net worth, find transactions (including by #tag), summarise spending for a month, report on how a month went, review a whole year, list what investment accounts hold, work out how long a card or loan takes to pay off, show what's left in each budget, say what's safe to spend until payday, list bills and subscriptions, list goals, change a category (and make a rule), add a cash purchase, set a budget, create a goal, add savings to a goal, ask the banks for new transactions, and undo its last change. It can't move money and never sees bank passwords or Plaid keys.

If the assistant wants a key instead, tap **Make a key** under AI assistants (you see it once, and can disconnect it there any time). On the laptop, `node server.js mcp-key Sherry` also prints one (a "Bearer" token). Send it in the `Authorization: Bearer KEY` header. Only if the assistant has no place for a key, put it in the link as `https://YOUR-ADDRESS/mcp?key=KEY`, as a last resort: links get saved in histories and logs, so keep that link private. `node server.js mcp-revoke Sherry` signs out every assistant for that person.

## Send charges to Split it

If you also run [Split it](https://github.com/sherrypanaich/split-it), Budget it can add a charge there as a shared expense.

1. In Split it's folder, make a key for yourself: `node server.js mcp-key YOURNAME`
2. If Split it runs on this laptop or your home network, add its address to `budget-it.env` first, for example `SPLIT_IT_URL=http://localhost:8080`, and restart. (Without it Budget it only connects to a public https address.)
3. In Budget it: Settings, Split it. Paste Split it's address and the key.
4. Tap any charge, then Split it with someone, and pick the group.

**Count only my share in my budget** is ticked by default. When you pay $90 for groceries for three people, $30 stays in your Groceries budget and the other $60 becomes its own line, "Owed back by housemates", which doesn't count as spending. Untick it to keep the whole amount in your budget.

The key is encrypted on the laptop. Each person connects their own Split it account.

## Where your data goes

Your budget lives in `data/` on your laptop. Budget it has no server of its own anywhere else, so nothing comes to us, and there are no ads and no tracking. Here's exactly who sees what:

- **Whoever runs the laptop.** Each person's budget is private from the others in the app, but anyone who can open the files in `data/` can read everything in it: every budget, transaction and receipt. Pick someone the household trusts.
- **Plaid, if you connect a bank.** Plaid sees the bank data it fetches for you: balances and transactions. That is how the data reaches your laptop. Plaid's privacy policy covers what it does with it. With CSV import and accounts kept by hand, Plaid sees nothing.
- **An AI assistant, if you connect one.** It sees what it asks for (balances, transactions, budgets), and so does the company that makes it.
- **The tunnel, if you reach the laptop from outside.** A Cloudflare tunnel carries all the traffic between your phone and the laptop, and Cloudflare unwraps the https on the way, so it could see what passes through. Tailscale Funnel passes it along still encrypted, ending at your laptop.
- **Email and Google sign-in, if you set them up.** Resend delivers the sign-in emails. Google confirms who you are.
- **Phone notifications.** The words of a notification pass through Apple's or Google's push service, encrypted so only your phone can read them.
- **Today's rates.** Tapping Get today's rates asks the Bank of Canada (CAD homes) or frankfurter.app (other home currencies, the European Central Bank's rates) for exchange rates. Only the currency codes are sent.
- **Fonts and Plaid's sign-in window** load from Google Fonts and Plaid when you open the page.
- **The update check.** The owner's page asks GitHub for the newest version number.

## Other handy bits

- `node server.js list-users`, `set-password NAME`, `remove-user NAME` (also disconnects their banks), `code-off NAME`. These work while the app is running and take effect right away. No restart needed.
- Rules: tick "Always put it here" when you change a category. Budgets, Rules lists and removes them.
- Share an account: open it on the Accounts page and tick the people who can see it. They see its balance and charges, read only, and it doesn't count toward their budgets. Nobody else does. (An account shared with everyone before 1.1 stays shared with the people who were here then.)
- Other currencies: totals are in CAD unless you change it in Settings, Currencies. Get today's rates works for any home currency.

## Character art

The guide characters in `public/art/` are not covered by the MIT licence and may not be reused. If you own something shown here and want it removed, [open an issue](https://github.com/sherrypanaich/budget-it/issues/new) and we'll take it down.

## Made with AI

AI tools were used to help build this project, including its code and artwork.
