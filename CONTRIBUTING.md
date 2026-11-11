# Contributing to Budget it

Budget it is a small, dependency-free app: one Node server and one HTML page. Keep it that way.

## Ground rules

- **No npm packages.** The server runs on plain Node 22+ and talks to Plaid with `fetch`. The page uses only what the browser gives it, plus Plaid Link and Google Fonts from their CDNs.
- **One set of money rules.** `budget.js` (sums, budgets, bills, CSV) and `ops.js` (every change a person can make) run on the server, in the tests and in the page. Don't copy them into the page.
- **One page, two homes.** `public/index.html` runs on the laptop server and, with sample data, as the Claude artifact preview. Anything that needs the server checks `LAPTOP`.
- **Never log or return a Plaid access token.** They only exist decrypted inside `server.js` while talking to Plaid.
- **No AI inside the app.** Nothing in Budget it calls an AI service. People who want one connect their own assistant through `mcp.js`.
- **Shared with Split it.** `accounts.js` and `push.js` are the same files Split it uses. Change them in both repos together; a test compares them when the two folders sit side by side.
- **The server decides.** Every change goes through `ops.js` on the server. The page never gets to say what a balance is, and changes only the server may make (like `txn.share`) are refused from the page.
- **Plain language in the UI.** Short sentences, no jargon, no exclamation marks except from the guides. Errors say what to do next.
- **Characters are hand-made art, not code.** Add a guide with four images in `public/art/<id>-{happy,calm,worried,celebrate}.webp` and lines in `LINES`.
- **Light mode is the reference.** Dark mode must look as good, but don't change light mode to get there.

## Running it

```
node server.js add-user You
node server.js sample You      # optional: made-up data to click around
node server.js
node --test test/*.test.js
```

The tests run the real server against a stand-in Plaid, so they need no keys. `test/server.test.js` covers budgets, banks and the assistant; `test/safety.test.js` covers signing in, the owner's page, backups and the laptop commands. `test/upgrade.test.js` opens a data folder and a backup made by Budget it 1.0.0 (`test/fixtures/v1.0.0`, made with `test/fixtures/make-v1.0.0.js`); a change to what's saved on disk has to keep that working.

## Layout

- `server.js`: HTTP, storage (`data/db.json`), sessions, Plaid sync, live updates (SSE), notifications, backups, admin commands.
- `plaid.js`: the Plaid API calls and token encryption.
- `budget.js`: the money rules. `ops.js`: every change, with checks. `sample.js`: sample data.
- `accounts.js`: invites, email (Resend), Google sign-in, password reset, sign-in codes.
- `mcp.js`: the AI-assistant connector (MCP over HTTP, OAuth).
- `push.js`: Web Push without a library.
- `public/index.html`: everything the person sees. `public/sw.js`: installable app, offline, notifications.

## Before you open a pull request

1. `node --test test/*.test.js` passes.
2. You opened every screen you touched on a phone-sized window, light and dark.
3. `CHANGELOG.md` has a line for people, not for developers.

## Releases

Versions follow `vMAJOR.MINOR.PATCH`: a patch for fixes only, a minor for new features, a major for changes that need people to do something when they update.

1. Add a section to the top of `CHANGELOG.md`, headed `## vX.Y.Z · Month D, YYYY`, with a bold one-line headline, then Highlights, New, Improved, Fixed, Security and Known issues (leave out any that are empty).
2. Set `VERSION` in `server.js` to the same number, and update the What's new card in `public/index.html`.
3. After the pull request is merged, tag main (`git tag vX.Y.Z && git push origin vX.Y.Z`), or run the Release workflow from the Actions tab with the version. It runs `scripts/smoke-docker.sh` first (build the image, sign in, restart, data and time zone still right), then publishes a GitHub Release titled "Budget it vX.Y.Z: headline" from that changelog section. Run the smoke test yourself before tagging if you changed `Dockerfile`, `compose.yaml` or `budget-it.env.example`.
