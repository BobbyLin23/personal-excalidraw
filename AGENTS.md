# Personal Excalidraw

- Use pnpm (pinned in `package.json`) and `pnpm install --frozen-lockfile` to install dependencies.
- `pnpm run dev` runs the React UI and Cloudflare Worker together with local D1 and R2 bindings.
- `pnpm run db:local` applies migrations before starting the development server. Local data is under `.wrangler/state` and is not production data.
- `pnpm run build` type-checks and bundles the app. Do not deploy or run `pnpm run db:remote` without the owner's approval.
- Cloudflare Access must protect the entire deployed Worker (including `/api/*`) before using it for private drawings. The Worker intentionally has no browser-stored API token.
- Drawing metadata is in D1; complete Excalidraw documents, including embedded image data, are stored as R2 objects. Keep the document format compatible with Excalidraw import/export.
