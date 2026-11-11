# What's new in Budget it

## v1.1.0 · Draft, not released yet

**Safer to run, kinder to your history.** Disconnecting a bank no longer throws away its history, one person's wrong passwords no longer lock everyone out, a full disk no longer stops the app, and you can connect your own AI assistant from Settings.

### Highlights
- **Your history stays.** Disconnect a bank and its accounts, charges and your edits stay put. Reconnect it and the history carries on with no doubles.
- **Built for running behind Coolify and Cloudflare.** Each visitor gets their own wrong-password limit, and changes sent from other websites are refused.
- **Find your people.** Everyone gets an @tag, a friend link with a QR code, and accounts can be shared with the people you pick instead of everyone here.
- **Faster, and works offline.** Opening a budget with years of history takes a fraction of a second, and the phone app keeps working when the laptop is asleep.
- **Connect your own AI assistant.** Link Claude, Muse or ChatGPT from Settings, with one tap if you're already signed in, and make read-only keys.

### New
- Settings has a new **AI assistants** page: your connector link with a Copy button, steps for adding it to Claude, and a list of the assistants and keys that act as you, with when each was last used. Make your own key there (it's shown once), tick **Read only** for an assistant that should only look, and disconnect one or all of them with a tap.
- One-tap Allow: if you're already signed in to Budget it in that browser, connecting an assistant takes one tap. This also fixes the dead end for people who signed up with Google and have no password. The page shows where access goes ("Budget it sends access to: claude.ai").
- `node server.js mcp-key NAME --read-only` makes a read-only key on the laptop.
- **People and friends** in Settings: your own @tag (change it any time), find someone already on Budget it by their exact @tag or checked email and send a friend request, your friend link with a QR code ("Make a new link" turns the old one off), and your open invite links and requests with Cancel.
- Share an account with the people you pick: the account sheet has a checkbox for each person, friends first. Accounts that were shared with everyone stay shared with the people who were here, and someone who joins later doesn't see them.
- Disconnecting a bank keeps its history. Its accounts show "Disconnected · history kept", and "Delete this history" removes it for good if you really want it gone.
- Reconnecting a bank carries its old accounts on, matched by bank, kind of account and last 4 digits. Charges that come back again are matched so nothing is doubled, and your categories, notes, tags, splits and receipts stay.
- When a bank needs you to sign in again, your phone gets one notification and it shows under "Needs you" with a Reconnect button.
- If a charge changes after you split it (a tip added when it posts), it's flagged under "Needs you": "<Store> changed from $X to $Y after you split it."
- Settings, **Your data**: download a copy of your own data, or delete your data and your account (you type your name to confirm).
- Extra safety copies of your budgets: one at every start (so every update has one) and one every 6 hours, on top of the daily and weekly ones.
- If the budgets file was damaged at start, whoever runs Budget it sees which copy was used and its date, until they dismiss it.
- Restore also takes a plain `db-….json` copy from `data/backups`.
- The owner's update check marks a security release with a red "Security update".
- Releases are checked on a real Docker host first: build, sign in, restart, and check the data and time zone are still right.
- The README has Docker install steps, how updating works, and a list of every setting.
- When Budget it is updated, a page left open on your phone says "A new version of Budget it is ready" with a Reload button.
- On an iPhone Home Screen Budget it opens like an app with its own name, and the status bar matches light and dark mode.

### Improved
- New bank connections ask for up to two years of history (was 180 days). Only the last 14 days land in "New from your bank".
- Each bank shows when it was last updated.
- Before a new bank connection on Plaid's production plan, Budget it says how many of your 10 connections are left, and that removing a bank doesn't give one back.
- A change you made offline that the laptop refuses is now shown to you instead of vanishing, and a change that keeps failing is set aside after 3 tries so the rest still go through.
- Signing out clears the phone's saved copy of your budget and any unsent changes (it asks first).
- A sign-in you keep using stays signed in: 90 days from the last day you used it, not from the day you signed in.
- Signing in through a link, including Google, returns you to where you were going.
- After a change, your assistant names the currency, and every tool that changes something tells the assistant to check with you first.
- When you send a charge to Split it, Budget it reads your share from Split it's numbers when Split it sends them.
- Backups written to a file are written as they go, one receipt photo at a time, so a big backup doesn't need a lot of memory.
- The owner's page warns from 90% disk full.
- With no Plaid keys, Home's "Get started" puts "Add an account by hand" first. The README now starts with CSV import and accounts by hand, with Plaid as the extra, and explains `PLAID_REDIRECT_URI`, the 10-connection limit, and trying Sandbox first.
- The README has a new "Running behind a proxy (Coolify, Traefik, Cloudflare tunnel)" section and a "Restoring a backup from the terminal" section for files over Cloudflare's 100 MB upload limit.
- New settings: `TZ` (reminders and "today" follow it; the Docker image now includes time zones), `TRUSTED_PROXY`, and `SPLIT_IT_URL`.
- The website and README say what it costs to run: about $70 a month for Budget it and Split it together, and linking bank accounts costs extra on top of that.
- A disconnected bank's account still counts in net worth but shows "last known", and is left out of safe to spend and the low-chequing heads-up.
- Removing or replacing a receipt photo can be undone; the photo file goes once Undo can't bring it back.
- Keyboard use: focus rings on search, quick add, amount boxes and the sign-in and join pages; the receipt button works with a keyboard; Tab inside a sheet reaches every toggle and text box.
- The Accounts page names the same assistants as Settings and has a Set up button, and a bank that needs signing in again says so in full.
- Picking several charges reads "Tag 3 charges" and "Move 3 charges to", the search box hint is shorter, and quotes and apostrophes are curly throughout.
- When the laptop can't be reached, sheets say "Couldn't reach the laptop. Check your connection and try again." instead of "Failed to fetch".
- Removing a receipt photo, and signing someone out on the owner's page, take a second tap.
- Assistants understand "today", "yesterday", "this month", "last month", month names and "last year", and amounts written as text like "$1,200".
- Assistants: every answer says its currency, foreign charges show their own currency too, and empty results get plain answers.
- Assistants see your own category names, including ones you renamed or added.
- `install.sh` refuses to run as root, keeps `budget-it.env` private on every run, installs curl if it's missing, and its self-check never uses your real settings.
- `budget-it.env.example` lists every setting.
- The Docker image can't change its own files, its health check follows `PORT`, and `.dockerignore` keeps tests and backups out of it.
- Changes made offline still work after the app is reopened offline, and show straight away; the app opens offline even right after its first use.
- When the laptop is off or asleep, the phone shows your last copy and keeps your changes until it's back, instead of an error page, and catches up by itself when it's back.
- Changes made offline are never saved twice, even if the connection drops just as they're sent.
- Much faster with a big budget: with 5 years and 25,000 charges, opening drops from about 3 seconds to 0.3, a 5,000-row CSV import from about a minute to under a second, and a bank update from 3 seconds to 0.3.
- Turning on notifications sends "Notifications are on" only to that phone.

### Fixed
- Behind a proxy (Coolify, Traefik, a Cloudflare tunnel), five wrong passwords from anyone locked everyone out of signing in for 15 minutes. Each visitor now has their own limit.
- Someone guessing at your name can no longer lock you out; your sign-in just slows down for a bit.
- After about 500 apps registered, no new AI assistant could ever connect. Apps that never finished signing in are now cleared after a day.
- An assistant that retried after a slow reply could add the same cash purchase or goal twice. The same add within 2 minutes is now answered "Already added a moment ago".
- A full or failing disk no longer stops the app. The change that couldn't be saved says so, it's retried, and the owner sees a warning.
- Restore checks every file before replacing anything, so a wrong file can't break the app.
- A test that hung now and then is fixed.
- CSV import: two identical charges in one file both come in, and importing the same file again still adds nothing.
- CSV import: impossible dates and amounts are skipped instead of saved broken, and "25/12/2026" is read as day/month.
- Amounts of a billion or more are refused everywhere you type an amount, and cash with a date that doesn't exist uses today.
- A bill charged on the 31st one month and the 1st the next is found as a bill, and bills due on the 1st (like rent) get their evening reminder.
- "Tomorrow" for reminders is right on the evening before the clocks change.
- When the bank takes back a charge you had split, the split-off part goes too, and a broken transfer gets its category back.
- Undo after a bank update or a disconnect can no longer bring back an older budget and lose charges.
- Disconnecting a bank while it was updating can't reconnect its accounts.
- Removing one of your own categories moves your bills in it too.
- Deleting an account a goal followed keeps the goal's saved amount in home money.
- Changing your home currency converts each account's past charges too.
- Sample data is no longer shared with everyone on the laptop.
- Restoring a backup from before 1.1 turns "shared with everyone" into the people who are here.
- One person's budget that can't be worked out no longer stops everyone else's reminders.
- A mistyped range in `TRUSTED_PROXY` is skipped instead of stopping Budget it from starting.
- Broken sign-in requests from an assistant get a clear refusal instead of an error.
- An assistant can add the same cash purchase twice on purpose when you really bought it twice.
- Invite links end when the person who sent them deletes their account.
- A damaged or oversized backup is refused with a plain message.
- Activity no longer scrolls sideways on a phone, the guide's speech bubble no longer covers its face on a laptop, and month names in a category's trend are no longer cut off.
- Split it groups show by their real names, and sending works with Split it 2.2 (it puts group names in quotes).
- Sending a charge to a Split it trip group in another currency works: Budget it says the amount is in your home currency with no card fee.
- "Count only my share" is right when Budget it and Split it use different currencies.
- Sending a charge again doesn't count your share twice, and a look-alike charge Split it didn't add isn't marked as sent.
- "Send again" after "count only my share" sends the whole charge.
- Assistants: amounts show in your own home currency, not always dollars, and holdings in their account's currency.
- Assistants: "12,50", impossible dates, past goal dates, empty goal names and budgets for Income or Transfer are refused with a clear message instead of guessed.
- After updating from 1.0, assistant keys older than 90 days keep working (1.0 never recorded when a key was used, so they'd have been switched off).
- A backup taken from the terminal while the app runs includes the latest changes.
- Laptop commands work after the app was killed or the power went out (a leftover lock file said it was still running).
- An empty `TZ=` line no longer switches the app to UTC, and a `PORT` in `budget-it.env` is no longer overridden by the systemd service.
- The example settings no longer set `PUBLIC_URL` to a made-up address that sent assistant sign-ins nowhere; `install.sh` clears it from existing installs.
- SECURITY.md and README wording matches v1.1.0 (shared accounts, links).
- Budget it reads Split it's group list from its data when Split it 2.2 sends it.
- Notifications the laptop had lost (after a restore, or when the phone renewed them) start working again by themselves.
- A change made offline that couldn't be saved says what it was, instead of "Saved".

### Security
- Changes sent to Budget it from another website are refused.
- Sign-in tokens are stored hashed, so a copied backup can't be used to sign in. Existing sign-ins keep working.
- Changing your email needs your current password or a sign-in code.
- The Split it address can no longer be used to make the laptop call things on its own network. Set `SPLIT_IT_URL` for a Split it on the same laptop or home network.
- Copies off the laptop leave out the bank key until `BACKUP_PASSPHRASE` is set, and the owner's page says so.
- A damaged or unreadable bank key stops the app with a clear message instead of being replaced, which would have broken every bank connection.
- Assistant keys and sign-ins unused for 90 days stop working (sign-ins used to last a year). One address can register at most 20 assistant apps an hour.
- Names and notes from people and banks are passed to assistants as quoted data, never as instructions.
- CSV exports can't carry spreadsheet formulas.
- A shared account was visible to every login on the laptop. Now only the people you picked see it.
- The README and website say exactly who sees what: Plaid sees the bank data it fetches, a connected assistant sees what it asks for, Cloudflare carries the traffic if you use a tunnel, and whoever runs the laptop can read everything.
- Backup copies that aren't locked with a passphrase never include the bank key, even from before a bank was connected.
- Wrong-password and sign-up limits count a whole IPv6 network as one visitor, so hopping addresses doesn't get around them.
- The assistant sign-in page never sends you on to another site before you've seen where it goes.
- Tighter limits on what an assistant app can register, and at most 50 calls in one batch.
- `data/oauth.json` is readable only by the laptop's user, and a `?key=` in an assistant's link never ends up in the log.
- Person ids like `__proto__` are refused on the owner's page and when sharing an account.
- Friend requests and friend links notify someone at most once an hour.
- Signing out turns off that phone's notifications and clears its cached receipt photos.

### Known issues
- Anyone using a Split it on the same laptop (like `http://localhost:8080`) needs to add `SPLIT_IT_URL` to `budget-it.env` and restart; the error message says what to add.
- A disconnected bank's balance is its last known one until you reconnect it.

## v1.0.0 · November 9, 2026

**Meet Budget it: your whole money picture, kept on your own laptop.** Connect your banks, set a budget for each kind of spending, and let Luffy or Hancock tell you how the month is going. Your budget is stored on your own machine, with no ads and no tracking.

### Highlights
- **Every account in one place.** Balances and transactions come in from your banks through Plaid, read only. Banks Plaid can't reach can be added with a CSV.
- **Budgets that keep up by themselves.** Charges sort themselves into categories, and you get a phone nudge when a budget is at 80% and again if it runs out.
- **Ask your AI assistant.** Budget it has its own MCP server, so Claude or Muse can answer "how much did I spend on dining this month?" or add a cash purchase for you.
- **Safe to spend until payday.** Budget it finds your paycheque and shows what's free until the next one, after cards and bills.
- **Works with Split it.** Send any charge to a Split it group in two taps, and count only your share in your budget.
- **Safe to host.** A sign-in code from an authenticator app, backups you can lock with a passphrase, and a page for whoever runs it.

### New
- Home: what's left to spend this month, a pace bar that shows if you're ahead of the month, "Safe till payday", your net worth, and a line on how this week compares with a usual week.
- Heads-ups under "Needs you" (and on your phone): a much bigger charge than usual, a new subscription, a subscription that went up in price, and chequing running low before bills. Dismiss each one once.
- Monthly budgets for nine categories, with rollover of leftovers or carrying overspending into next month, and "Suggest budgets" from what you spent last month.
- Your own categories: rename any of them, or add up to 20 of your own (Pets, Kids, Gifts...) with an icon and colour.
- Check new charges one at a time, and tick "Always put it here" to make a rule for next time. Rules also fix past charges. Rules can match names that start with or contain a word, and you can edit them.
- Budget it remembers the category you used last time for the same store.
- Card payments and moves between your own accounts are matched as transfers, so they don't count twice.
- Select many charges in Activity and change their category, tag or hide them all at once.
- Rename, add a note, add tags like #japan-trip, attach a receipt photo, or split a charge across two categories.
- "Don't count this" for charges that aren't really spending, like a refund you passed on.
- Send a charge to Split it: pick a group and it's added there as an expense you paid.
- Count only your share: when you send a charge to Split it, the part your housemates owe back stops counting as your spending. Pay $90 for three people and $30 stays in Groceries; the other $60 shows as "Owed back by housemates".
- Your sign-in, in Settings: change your password, add an email, connect Google, turn on a sign-in code, or sign out on all devices.
- A page for whoever runs it (Settings, People, backups and health): who is here, reset links for people who are locked out, the health of the laptop, backups and restore, and a note when a newer Budget it is out.
- Download a backup locked with a passphrase, and restore a backup from the app. What was there before is kept first.
- A second place for backups: set a USB drive or a synced folder and a full backup goes there every day, 14 kept. The owner's page warns when there is none or the copy is getting old.
- The Connect a bank screen shows how many of Plaid's 10 free bank connections are used, and Disconnect warns that removing a bank doesn't give one back.
- Banks that approve the connection in their own app or site can send you back to Budget it (set `PLAID_REDIRECT_URI`).
- Get today's rates works for any home currency, not just CAD.
- Laptop commands (`add-user`, `set-password`, `remove-user`, `sample`, `code-off`) work while the app is running and take effect right away. No restart needed.
- Bills and subscriptions found from charges that repeat (or by your bank, through Plaid, when it offers that), and streaming and app subscriptions like Netflix or Crave from their very first charge, shown on a calendar, with the yearly cost of your subscriptions and a reminder the evening before one is due. Add bills it can't spot yourself, monthly or once a year.
- Tags and trips: see what a trip or event cost across every category.
- Savings goals that tell you how much to put away each month to finish on time. A goal can follow a savings account, so it fills in by itself.
- "Plan your pay": your take-home pay split into budgets, goals and money with no job yet.
- Activity: every month you have, day-by-day spending compared with last month, search across all months by store, note, amount or #tag, and filters by category.
- Trends: six months of spending by category, and how each month compared.
- Your year: what came in, what went out and how much you kept, where it went by category, your top five places, your biggest and lightest months, and what subscriptions cost a year. Flip back to earlier years.
- Net worth over time: a chart on Accounts with your net worth at the end of each month, and how much it's gone up or down.
- Investments: see what each investment account holds (VFV, XEQT, a stock), what it's worth and how much it's up or down. Holdings come from your bank through Plaid where it shares them, or add them yourself to an account you keep by hand and Budget it keeps its balance as their total.
- Update prices: change the price of every holding you added by hand in one sheet, with the new total as you type. Or ask Claude or Muse: "VFV is 135.20 now".
- Other currencies: a US dollar (or euro, or any of 16) account keeps its own money, and net worth, safe to spend and goals add up in your home currency (CAD unless you change it). Set the rate in Settings, Currencies, or on the laptop tap Get today's rates for the Bank of Canada's. Charges in another currency show what they were, like "Was US$20.00". A charge that came in before you set a rate gets it when you do, and changing an account's currency moves its charges with it.
- Pay it off: on a credit card or loan, add the interest rate and what you pay each month to see when it's paid off and how much interest it costs, or what to pay to clear it in 6 or 12 months.
- Export everything to a CSV for a spreadsheet or your taxes.
- CSV import shows a preview first, and can flip the signs for banks that show spending as +.
- A wanted poster for the place that took the most money this month.
- Quick add for cash: type "coffee 4.50".
- Household sharing: invite people with a link. Each person has a private budget, and can share chosen accounts with everyone else, read only.
- Luffy and Hancock react to how your month is going. You can switch guides or turn them off.
- Works as a phone app: add it to your Home Screen, get notifications, and see your last numbers when offline.
- Try it with sample data first, and remove it in one tap.
- Accounts you keep by hand (cash, a credit union, a loan): add one with today's balance and update it when you like.
- On a laptop or tablet: a side menu and two columns, with sheets that open in the middle of the screen.
- Hide amounts: one tap blurs every number, for checking your budget in public.
- A Sunday evening check-in on your phone with how the week went.
- The phone's Back button closes sheets and pages, and changes made offline are sent when you're back online.
- The assistant can also tell you what's safe to spend, list your bills, report on a month or a whole year, plan paying off a card, set a budget and create a goal.
- On a laptop or tablet, Accounts and Settings are in the side menu too.
- Easier with a screen reader or keyboard: every screen passes an automatic accessibility check (WCAG 2.1 AA) in light and dark mode. Sheets have names, Tab stays inside an open sheet, the main area is marked for screen readers, and green amounts and small labels are darker so they're easier to read.

### Fixed
- Quick add read "$1,200 rent" as $1. Amounts with a thousands comma now work.
- Renaming a bank account no longer switches back to the bank's name at the next update.
- Splitting a charge no longer copies its receipt photo and Split it mark onto the second part. Deleting the second part of a split cash purchase puts its amount back on the first.
- Changing the category of a matched transfer in "Select" or "Check new charges" now unmatches the other side too, and the change is kept.
- On Claude, a receipt photo too big to save no longer leaves the charge pointing at a photo that isn't there.
- Big totals no longer run off the edge of the screen on a phone.
- On a tablet, the side menu's Accounts and Settings icons were squashed.
- The assistant connection no longer fails with a server error when an AI app sends a request without its details, and every tool now answers plainly when it gets an odd value.
- A change sent with an empty or broken body now gets a clear "Bad request" instead of a server error.

### Security
- A sign-in code from an authenticator app as an optional second step, with 8 backup codes. A password reset link doesn't skip it.
- Changing or resetting your password signs out your other phones at once and stops their live updates. A reset, and "Sign out on all devices", also disconnect any AI assistant.
- 10 wrong passwords on one account pause that account for 15 minutes, wherever the tries come from.
- Backups can be locked with a passphrase (AES-256-GCM). With `BACKUP_PASSPHRASE` set, every copy off the laptop is locked.
- Whoever runs Budget it sees people and health, never anyone's accounts, charges or budgets.
- In a container, the app runs as an ordinary user, not root.
- Needs Node.js 22 or newer. Older ones no longer get security fixes.
- You sign in to your bank inside Plaid's own window, so Budget it never sees bank passwords. It can read balances and transactions but can't move money.
- Bank connections are encrypted (AES-256-GCM) on your laptop with a key only you can read. They never go to the browser.
- Invite-only sign-in, with the same protections as Split it: slow password hashing, a 15-minute pause after 5 wrong tries, and secure cookies.
- Disconnecting a bank deletes its connection at Plaid too.
- Receipt photos are saved on the laptop and only shown to the person who added them. They're never shared with the household.
- Your Split it key is encrypted like bank connections and never goes to the browser.
- Backups every day (30 kept) and every week (a year kept), and every receipt photo is copied into `backups/receipts`. `node server.js backup` writes everything, photos included, to one zip.

### Known issues
- Some banks don't share holdings through Plaid. Those investment accounts show only their balance.
- Prices of holdings you add by hand don't update by themselves. Change the price when you want a fresh total.
- Exchange rates change only when you change them (or tap Get today's rates on the laptop).
- New charges arrive every few hours (or when you tap Update), not the moment you pay.
- Plaid starts in test mode. Real banks need the Production secret from your Plaid dashboard (README, step 4).
- Plaid's free plan allows 10 bank connections for the whole laptop, and a disconnected bank still counts.
- Budget it hasn't been run against real banks yet, only Plaid's test bank and a stand-in. Coming back from a bank that approves the connection in its own app is the least tested part.
- The sign-in code is set up by tapping a button or typing a key. There is no QR code to scan yet.
- The container set-up hasn't been tried on a real Docker host yet.
- A lost backup passphrase can't be recovered.
- The Claude version saves your own budget, but can't connect banks or send to Split it. Those need the laptop app.
