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

Run `pnpm run db:local` after pulling this change to add the auth tables without changing existing drawings. `pnpm test` runs Worker-runtime integration tests with isolated D1/R2 and mocked email delivery; it sends no real email. The test pool currently uses its bundled runtime's August compatibility date, while the app retains its September date.

## Deploy to Cloudflare

Configure production Worker secrets using `pnpm exec wrangler secret put NAME` for each of `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `AUTH_EMAIL`, `RESEND_API_KEY`, and `EMAIL_FROM`. The URL must be your exact public HTTPS origin. Never put these credentials in frontend `VITE_*` variables or commit them. Apply the auth migration and configure secrets before using the deployed login.

Before storing private content, also configure a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-app/) for the entire Worker hostname (not only the UI path), with an allow policy limited to your identity. This project retains Access as an additional deployment protection. A custom domain behind Access is recommended; ensure any `*.workers.dev` route is disabled or protected too. Without Access, the login page and static assets are public, but drawing APIs require the app session. Check unauthenticated `/api/drawings` requests are denied.

From an authenticated Wrangler session, build and deploy, then apply the schema:

```sh
pnpm run build
pnpm exec wrangler deploy
pnpm run db:remote
```

Wrangler's D1 and R2 bindings in `wrangler.jsonc` use [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) on first deployment. Check your account has R2 enabled. Back up your data by exporting drawings using Excalidraw's file menu; this app does not provide automatic backups, conflict resolution between tabs, or collaboration. Cloudflare deployment and remote schema changes affect your account and should only be run when you intend to publish.
