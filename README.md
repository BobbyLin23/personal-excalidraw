# Personal Excalidraw

A small, single-user Excalidraw host for Cloudflare Workers. The React editor and API run on one Worker; D1 indexes drawings and R2 stores each complete `.excalidraw` document, including embedded images. Create, rename, save, open and delete drawings from the top bar. Saving is **manual**; the app warns before discarding unsaved changes. Excalidraw's own menu can export a local backup.

## Local development

Requires Node.js 20.19+ and pnpm 12.0.0. Install pnpm using the [pnpm installation guide](https://pnpm.io/installation). The `packageManager` field pins the project's pnpm version.

```sh
pnpm install --frozen-lockfile
pnpm run db:local
pnpm run dev
```

The Vite server runs the Worker with local D1/R2 emulation. `.wrangler/state` holds local data and is ignored by Git. Run `pnpm run build` to check types and create a deployable bundle.

## Saving safely

The editor and title are temporarily locked during save, open, create, delete, and sign-out requests. Failed requests leave the current editor available. Saves write a new immutable R2 object, then atomically commit its object key, title, timestamp, and revision in D1. A stale tab receives a conflict rather than overwriting another tab's save; export your edits before reopening the drawing to load its latest version.

Previous object versions are retained until the drawing is deleted, so storage grows with each save. They are not an automatic backup or an in-app history feature. A storage/commit failure can also leave an unreferenced candidate object; it is retained because an ambiguous D1 failure may have committed. Delete removes the legacy file and all version objects. If cleanup fails, the drawing is hidden from the library and cannot be saved again; keep its editor open and retry Delete to finish cleanup. Deletion is idempotent.

`pnpm test` covers authentication, migration of existing drawings, image roundtrips, invalid documents, storage failures, and racing saves/deletes. With the dev server running and `agent-browser` installed, `node tests/ui-regression.mjs` checks delayed-request locks and conflict/error recovery in Chromium. It mocks API responses only in its isolated browser, sends no email, and does not modify local drawings. Pass a dev-server URL as its first argument if needed.

## Email-only login

The Excalidraw React package supplies the editor, not authentication. This app uses [Better Auth's Email OTP plugin](https://better-auth.com/docs/plugins/email-otp): enter your email, receive a six-digit code, then sign in. No password or social login is enabled. Codes expire after five minutes, are stored hashed, and allow three wrong attempts. Sessions use HttpOnly cookies; production HTTPS cookies are Secure. Sign out revokes the session, with a warning before discarding unsaved drawings.

This remains a **single-user app**. Only `AUTH_EMAIL` can sign in, including on first use; all existing drawings remain available to that owner. This is not a multi-user app with separate drawing libraries. Every drawing API checks the session and owner email. Missing auth configuration fails closed.

For local development, create a git-ignored `.dev.vars` file with:

```dotenv
BETTER_AUTH_SECRET=<random secret of at least 32 characters>
BETTER_AUTH_URL=http://localhost:5173
AUTH_EMAIL=you@example.com
RESEND_API_KEY=<your Resend API key>
EMAIL_FROM=My drawings <login@your-verified-domain.com>
```

Generate the secret locally with `openssl rand -base64 32`. [Resend](https://resend.com/docs) requires a verified sending domain (its test sender can only send to the account owner's email). Use the same sender and recipient restrictions locally; there is no development auth bypass or code logging. Set `BETTER_AUTH_URL` to the exact origin you open in your browser; for an orb portal, use its HTTPS portal origin rather than localhost. Restart the dev server after changing `.dev.vars`.

Better Auth returns a successful code-request response even if email delivery fails, and logs the failure on the Worker. If no code arrives, check spam and the Worker/Resend logs, then resend. Request acceptance does not guarantee inbox delivery.

Run `pnpm run db:local` after pulling changes to apply the auth and drawing-revision migrations without replacing existing drawing files. `pnpm test` runs Worker-runtime integration tests with isolated D1/R2 and mocked email delivery; it sends no real email. The test pool currently uses its bundled runtime's August compatibility date, while the app retains its September date.

## Deploy to Cloudflare

Deploy this project as a **Cloudflare Worker**, not a Pages project. The Vite build produces both the React assets and the API Worker. You need a Cloudflare account with Workers, D1, and R2 enabled, plus a Resend API key and verified sending domain.

1. Install dependencies and authenticate Wrangler on your machine:

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec wrangler login
   pnpm exec wrangler whoami
   ```

2. Build and deploy, then apply the database migrations:

   ```sh
   pnpm run deploy
   pnpm run db:remote
   ```

   Wrangler's D1 and R2 bindings in `wrangler.jsonc` use [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) on first deployment. Review any resource creation/selection prompts and confirm `DRAWINGS` points to the intended D1 database and `FILES` to the intended R2 bucket in the Worker dashboard. Retain any resource IDs/names Wrangler writes into the configuration. The Vite plugin generates the deployment configuration during the build; always rebuild before deploying changed code or configuration. The API intentionally returns 503 until all auth settings are supplied.

3. Choose your final HTTPS hostname (prefer a custom domain configured under Workers & Pages → `personal-excalidraw` → Settings → Domains & Routes), then set each Worker secret interactively:

   ```sh
   pnpm exec wrangler secret put BETTER_AUTH_SECRET
   pnpm exec wrangler secret put BETTER_AUTH_URL
   pnpm exec wrangler secret put AUTH_EMAIL
   pnpm exec wrangler secret put RESEND_API_KEY
   pnpm exec wrangler secret put EMAIL_FROM
   ```

   Use a random secret of at least 32 characters (`openssl rand -base64 32`), your exact public HTTPS origin for `BETTER_AUTH_URL` (for example `https://drawings.example.com`), your owner email for `AUTH_EMAIL`, and a verified Resend sender for `EMAIL_FROM` (for example `Drawings <login@example.com>`). Never put these credentials in frontend `VITE_*` variables or commit them. Local `.dev.vars` does not configure production secrets.

Before storing private content, also configure a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-app/) for the entire Worker hostname (not only the UI path), with an allow policy limited to your identity. This project retains Access as an additional deployment protection. A custom domain behind Access is recommended; ensure any `*.workers.dev` route is disabled or protected too. Without Access, the login page and static assets are public, but drawing APIs require the app session. Check unauthenticated `/api/drawings` requests are denied.

### Initialize the owner (admin)

There is no separate admin role or password in the database: `AUTH_EMAIL` determines the single authorized owner. The first successful email OTP login creates that user automatically. To pre-create the owner explicitly, apply migrations first, then run:

```sh
# Local database only:
pnpm run db:local
pnpm run admin:init --local you@example.com "Your Name"

# Production database (intentional remote write):
pnpm run db:remote
pnpm run admin:init --remote you@example.com "Your Name"
```

The email **must match `AUTH_EMAIL`**; the script cannot read or change that remote secret. The name is optional and defaults to `Owner`. The script normalizes the email, safely quotes SQL values, and leaves existing users untouched on repeat runs. It does not create a password, session, or verified email: you must still complete the email OTP login. It requires an explicit `--local` or `--remote` target and removes its temporary SQL file afterward.

For an **existing deployment**, apply `pnpm run db:remote` before deploying this revision-aware Worker. The migration adds fields and points existing rows at their original R2 files; it does not replace those files. Reload already-open browser tabs after upgrading, since saves now require the revision returned by the API. Remote migrations and deployment require the owner's approval.

### Verify the deployment

- Run `pnpm exec wrangler deployments list` and `pnpm exec wrangler secret list` to check the deployed Worker and presence of all five settings (secret values are not shown).
- In the Cloudflare dashboard, confirm the D1/R2 bindings and Access policy cover the final hostname and any alternate routes.
- Open the site in a private browser window. Access should challenge an unauthenticated visitor. After passing Access but before app login, `/api/drawings` should return 401, not drawing data. A 503 means app auth configuration is incomplete.
- Sign in with `AUTH_EMAIL`, save a drawing, reload and reopen it, then sign out and confirm drawings are inaccessible.
- If email does not arrive, run `pnpm exec wrangler tail` and inspect Resend delivery logs. Do not share secrets or OTPs from logs.

Back up your data by exporting drawings using Excalidraw's file menu; this app does not provide automatic backups, conflict resolution between tabs, or collaboration. Cloudflare deployment and remote schema changes affect your account and should only be run when you intend to publish.
