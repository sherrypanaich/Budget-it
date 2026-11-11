# What's new in Budget it

## v1.1.0 · Draft, not released yet

**Connect your own AI assistant.** Everyone using Budget it can now link Claude, Muse or ChatGPT to their own budget from the app, and see or disconnect what's linked.

### New
- Settings has a new **AI assistants** page: your connector link with a Copy button, steps for adding it to Claude, and a list of the assistants and keys that act as you, with when each was last used.
- Make your own key for an assistant that asks for an API key or bearer token, right in the app. It's shown once, and only works as you.
- Disconnect one assistant, or all of them, with a tap. The Accounts page links here too.

### Security
- Keys and sign-ins are only ever listed and removed by the person they belong to. The list never shows a key itself.

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
