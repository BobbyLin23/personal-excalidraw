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

## Deploy to Cloudflare

**Do not expose this Worker publicly.** It has no built-in login: anyone able to reach it can read, change, or delete drawings. Before storing private content, configure a [Cloudflare Access self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-app/) for the entire Worker hostname (not only the UI path), with an allow policy limited to your identity. A custom domain behind Access is recommended; ensure any `*.workers.dev` route is disabled or protected too. Check unauthenticated requests to both `/` and `/api/drawings` are denied.

From an authenticated Wrangler session, build and deploy, then apply the schema:

```sh
pnpm run build
pnpm exec wrangler deploy
pnpm run db:remote
```

Wrangler's D1 and R2 bindings in `wrangler.jsonc` use [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) on first deployment. Check your account has R2 enabled. Back up your data by exporting drawings using Excalidraw's file menu; this app does not provide automatic backups, conflict resolution between tabs, or collaboration. Cloudflare deployment and remote schema changes affect your account and should only be run when you intend to publish.
