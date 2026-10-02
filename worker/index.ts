import { createAuth, type AuthEnv } from './auth';

interface Env extends AuthEnv {
  FILES: R2Bucket;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const key = (id: string) => `drawings/${id}.excalidraw`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (!env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL || !env.AUTH_EMAIL || !env.RESEND_API_KEY || !env.EMAIL_FROM) {
      return json({ error: 'Authentication is not configured. Contact the app owner.' }, 503);
    }
    const auth = createAuth(env);
    if (pathname.startsWith('/api/auth/')) {
      const routes: Record<string, string> = {
        '/api/auth/get-session': 'GET',
        '/api/auth/sign-out': 'POST',
        '/api/auth/email-otp/send-verification-otp': 'POST',
        '/api/auth/sign-in/email-otp': 'POST',
      };
      if (routes[pathname] !== method) return json({ error: 'Not found' }, 404);
      return auth.handler(request);
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return json({ error: 'Please sign in to access your drawings.' }, 401);
    if (!session.user.emailVerified || session.user.email.toLowerCase() !== env.AUTH_EMAIL.trim().toLowerCase()) {
      return json({ error: 'Not authorized' }, 403);
    }
    if (method !== 'GET' && request.headers.get('origin') !== new URL(env.BETTER_AUTH_URL).origin) {
      return json({ error: 'Invalid request origin' }, 403);
    }

    if (pathname === '/api/drawings' && method === 'GET') {
      const { results } = await env.DRAWINGS.prepare(
        'SELECT id, title, updated_at AS updatedAt FROM drawings ORDER BY updated_at DESC',
      ).all();
      return json(results);
    }

    if (pathname === '/api/drawings' && method === 'POST') {
      const id = crypto.randomUUID();
      const title = 'Untitled drawing';
      const updatedAt = new Date().toISOString();
      await env.FILES.put(key(id), JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }));
      await env.DRAWINGS.prepare('INSERT INTO drawings (id, title, updated_at) VALUES (?, ?, ?)')
        .bind(id, title, updatedAt).run();
      return json({ id, title, updatedAt }, 201);
    }

    const match = /^\/api\/drawings\/([0-9a-f-]{36})$/.exec(pathname);
    if (!match) return json({ error: 'Not found' }, 404);
    const id = match[1];

    if (method === 'GET') {
      const drawing = await env.DRAWINGS.prepare(
        'SELECT id, title, updated_at AS updatedAt FROM drawings WHERE id = ?',
      ).bind(id).first();
      if (!drawing) return json({ error: 'Not found' }, 404);
      const file = await env.FILES.get(key(id));
      if (!file) return json({ error: 'Drawing file missing' }, 500);
      return json({ ...drawing, scene: await file.json() });
    }

    if (method === 'PUT') {
      if (Number(request.headers.get('content-length')) > 10_000_000) return json({ error: 'Drawing too large' }, 413);
      let body: { title?: unknown; scene?: unknown };
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100 ||
          !body.scene || typeof body.scene !== 'object' ||
          !Array.isArray((body.scene as { elements?: unknown }).elements)) {
        return json({ error: 'Invalid drawing' }, 400);
      }
      const scene = JSON.stringify(body.scene);
      if (scene.length > 10_000_000) return json({ error: 'Drawing too large' }, 413);
      const exists = await env.DRAWINGS.prepare('SELECT id FROM drawings WHERE id = ?').bind(id).first();
      if (!exists) return json({ error: 'Not found' }, 404);
      const updatedAt = new Date().toISOString();
      await env.FILES.put(key(id), scene);
      await env.DRAWINGS.prepare('UPDATE drawings SET title = ?, updated_at = ? WHERE id = ?')
        .bind(body.title.trim(), updatedAt, id).run();
      return json({ id, title: body.title.trim(), updatedAt });
    }

    if (method === 'DELETE') {
      const result = await env.DRAWINGS.prepare('DELETE FROM drawings WHERE id = ?').bind(id).run();
      if (!result.meta.changes) return json({ error: 'Not found' }, 404);
      await env.FILES.delete(key(id));
      return new Response(null, { status: 204 });
    }

    return json({ error: 'Method not allowed' }, 405);
  },
} satisfies ExportedHandler<Env>;
