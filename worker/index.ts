import { createAuth, type AuthEnv } from './auth';

interface Env extends AuthEnv {
  FILES: R2Bucket;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const key = (id: string) => `drawings/${id}.excalidraw`;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function validScene(scene: unknown): boolean {
  if (!record(scene) || scene.type !== 'excalidraw' || scene.version !== 2 ||
      !Array.isArray(scene.elements) || !record(scene.appState) || !record(scene.files)) return false;
  const types = ['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw', 'text', 'image', 'frame', 'magicframe', 'embeddable', 'iframe'];
  const ids = new Set<string>();
  for (const element of scene.elements) {
    if (!record(element) || typeof element.id !== 'string' || !element.id || ids.has(element.id) ||
        typeof element.type !== 'string' || !types.includes(element.type) ||
        !['x', 'y', 'width', 'height', 'angle'].every((field) => typeof element[field] === 'number' && Number.isFinite(element[field])) ||
        typeof element.isDeleted !== 'boolean') return false;
    ids.add(element.id);
    if (element.type === 'text' && typeof element.text !== 'string') return false;
    if (['line', 'arrow', 'freedraw'].includes(element.type) &&
        (!Array.isArray(element.points) || !element.points.every((point) => Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === 'number' && Number.isFinite(n))))) return false;
    if (element.type === 'image' && !element.isDeleted &&
        (typeof element.fileId !== 'string' || !Object.hasOwn(scene.files, element.fileId))) return false;
  }
  for (const [id, file] of Object.entries(scene.files)) {
    if (!record(file) || file.id !== id || typeof file.mimeType !== 'string' ||
        (!file.mimeType.startsWith('image/') && file.mimeType !== 'application/octet-stream') ||
        typeof file.dataURL !== 'string' || !file.dataURL.startsWith(`data:${file.mimeType};base64,`) ||
        file.dataURL.length <= `data:${file.mimeType};base64,`.length ||
        typeof file.created !== 'number' || !Number.isFinite(file.created)) return false;
    const data = file.dataURL.slice(file.dataURL.indexOf(',') + 1);
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
  }
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (!env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL || !env.AUTH_EMAIL) {
      return json({ error: 'Authentication is not configured. Contact the app owner.' }, 503);
    }
    const auth = createAuth(env);
    if (pathname.startsWith('/api/auth/')) {
      const routes: Record<string, string> = {
        '/api/auth/get-session': 'GET',
        '/api/auth/sign-out': 'POST',
        '/api/auth/sign-in/email': 'POST',
      };
      if (routes[pathname] !== method) return json({ error: 'Not found' }, 404);
      return auth.handler(request);
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return json({ error: 'Please sign in to access your drawings.' }, 401);
    if (session.user.email.toLowerCase() !== env.AUTH_EMAIL.trim().toLowerCase()) {
      return json({ error: 'Not authorized' }, 403);
    }
    if (method !== 'GET' && request.headers.get('origin') !== new URL(env.BETTER_AUTH_URL).origin) {
      return json({ error: 'Invalid request origin' }, 403);
    }

    if (pathname === '/api/drawings' && method === 'GET') {
      const { results } = await env.DRAWINGS.prepare(
        'SELECT id, title, updated_at AS updatedAt, revision FROM drawings WHERE deleted = 0 ORDER BY updated_at DESC',
      ).all();
      return json(results);
    }

    if (pathname === '/api/drawings' && method === 'POST') {
      const id = crypto.randomUUID();
      const title = 'Untitled drawing';
      const updatedAt = new Date().toISOString();
      await env.FILES.put(key(id), JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }));
      await env.DRAWINGS.prepare('INSERT INTO drawings (id, title, updated_at, object_key) VALUES (?, ?, ?, ?)')
        .bind(id, title, updatedAt, key(id)).run();
      return json({ id, title, updatedAt, revision: 0 }, 201);
    }

    const match = /^\/api\/drawings\/([0-9a-f-]{36})$/.exec(pathname);
    if (!match) return json({ error: 'Not found' }, 404);
    const id = match[1];

    if (method === 'GET') {
      const drawing = await env.DRAWINGS.prepare(
        'SELECT id, title, updated_at AS updatedAt, revision, object_key FROM drawings WHERE id = ? AND deleted = 0',
      ).bind(id).first<{ id: string; title: string; updatedAt: string; revision: number; object_key: string }>();
      if (!drawing) return json({ error: 'Not found' }, 404);
      const { object_key, ...metadata } = drawing;
      const file = await env.FILES.get(object_key);
      if (!file) return json({ error: 'Drawing file missing' }, 500);
      return json({ ...metadata, scene: await file.json() });
    }

    if (method === 'PUT') {
      if (Number(request.headers.get('content-length')) > 10_000_000) return json({ error: 'Drawing too large' }, 413);
      let body: { title?: unknown; scene?: unknown; revision?: unknown };
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100 ||
          !validScene(body.scene) || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
        return json({ error: 'Invalid drawing' }, 400);
      }
      const scene = JSON.stringify(body.scene);
      if (scene.length > 10_000_000) return json({ error: 'Drawing too large' }, 413);
      const exists = await env.DRAWINGS.prepare('SELECT revision FROM drawings WHERE id = ? AND deleted = 0').bind(id).first<{ revision: number }>();
      if (!exists) return json({ error: 'Not found' }, 404);
      if (exists.revision !== body.revision) return json({ error: 'This drawing changed in another tab. Export your edits before reopening it.' }, 409);
      const updatedAt = new Date().toISOString();
      const objectKey = `drawings/${id}/${crypto.randomUUID()}.excalidraw`;
      // Never overwrite a committed scene. D1 is the single commit point.
      try {
        await env.FILES.put(objectKey, scene);
        const result = await env.DRAWINGS.prepare('UPDATE drawings SET title = ?, updated_at = ?, object_key = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted = 0')
          .bind(body.title.trim(), updatedAt, objectKey, id, body.revision).run();
        if (!result.meta.changes) {
          // This candidate was never committed. Cleanup failure must not imply success.
          await env.FILES.delete(objectKey).catch(() => {});
          return json({ error: 'This drawing changed or was deleted. Export your edits before reopening it.' }, 409);
        }
      } catch {
        // An ambiguous D1 failure might have committed. Do not delete its object.
        return json({ error: 'Could not confirm the save. Retry or export your edits as a backup.' }, 503);
      }
      return json({ id, title: body.title.trim(), updatedAt, revision: (body.revision as number) + 1 });
    }

    if (method === 'DELETE') {
      // A tombstone prevents saves from committing while deletion is in progress.
      // Keep it until cleanup succeeds so a failed DELETE can be retried.
      try {
        await env.DRAWINGS.prepare('UPDATE drawings SET deleted = 1 WHERE id = ?').bind(id).run();
        let cursor: string | undefined;
        do {
          const files = await env.FILES.list({ prefix: `drawings/${id}/`, cursor });
          if (files.objects.length) await env.FILES.delete(files.objects.map((file) => file.key));
          cursor = files.truncated ? files.cursor : undefined;
        } while (cursor);
        await env.FILES.delete(key(id));
        await env.DRAWINGS.prepare('DELETE FROM drawings WHERE id = ? AND deleted = 1').bind(id).run();
      } catch {
        return json({ error: 'Deletion is incomplete. Retry Delete to finish removing the stored files.' }, 503);
      }
      return new Response(null, { status: 204 });
    }

    return json({ error: 'Method not allowed' }, 405);
  },
} satisfies ExportedHandler<Env>;
