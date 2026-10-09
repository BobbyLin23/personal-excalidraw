import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import worker from '../worker';
import type { AuthEnv } from '../worker/auth';
import { adminSQL } from '../scripts/init-admin.mjs';

const bindings = env as unknown as AuthEnv & { FILES: R2Bucket; MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const base = 'https://drawings.example.com';
let ip = 0;
const password = 'test-only-owner-password';
let ownerSQL: string;

function request(path: string, method = 'GET', body?: unknown, cookie?: string, origin = base) {
  return worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin, 'cf-connecting-ip': `192.0.2.${ip}`, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), bindings);
}

async function login() {
  const response = await request('/api/auth/sign-in/email', 'POST', { email: 'Owner@Example.com', password, rememberMe: false });
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(response.headers.get('set-cookie')).toContain('Secure');
  expect(response.headers.get('set-cookie')).toContain('Max-Age=604800');
  return response.headers.get('set-cookie')!.split(';')[0];
}

beforeAll(async () => {
  ownerSQL = await adminSQL('owner@example.com', password, "Owner's drawings");
  await applyD1Migrations(bindings.DRAWINGS, bindings.MIGRATIONS.slice(0, 2));
  const id = '00000000-0000-0000-0000-000000000099';
  const objectKey = `drawings/${id}.excalidraw`;
  const legacyScene = { type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#abcdef' }, files: {} };
  await bindings.FILES.put(objectKey, JSON.stringify(legacyScene));
  await bindings.DRAWINGS.prepare('INSERT INTO drawings (id, title, updated_at) VALUES (?, ?, ?)').bind(id, 'Legacy drawing', '2025-12-31').run();
  await applyD1Migrations(bindings.DRAWINGS, bindings.MIGRATIONS.slice(2));
  expect(await bindings.DRAWINGS.prepare('SELECT * FROM drawings WHERE id = ?').bind(id).first()).toEqual({
    id, title: 'Legacy drawing', updated_at: '2025-12-31', revision: 0, deleted: 0, object_key: objectKey,
  });
  expect(await (await bindings.FILES.get(objectKey))!.json()).toEqual(legacyScene);
});
beforeEach(async () => {
  ip++;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected outbound request'); });
  await bindings.DRAWINGS.batch(['auth_session', 'auth_account', 'auth_user', 'auth_verification', 'auth_rate_limit', 'drawings'].map((table) => bindings.DRAWINGS.prepare(`DELETE FROM ${table}`)));
  await bindings.DRAWINGS.exec(ownerSQL);
});
afterEach(() => vi.restoreAllMocks());

it('initializes hashed owner credentials idempotently without changing an existing password', async () => {
  await expect(adminSQL('not-an-email', password)).rejects.toThrow();
  await expect(adminSQL('owner@example.com', password, ' ')).rejects.toThrow();
  await expect(adminSQL('owner@example.com', 'short')).rejects.toThrow();
  const owner = await bindings.DRAWINGS.prepare('SELECT * FROM auth_user').first();
  expect(owner).toMatchObject({ email: 'owner@example.com', name: "Owner's drawings", emailVerified: 0 });
  const account = await bindings.DRAWINGS.prepare('SELECT * FROM auth_account').first();
  expect(account!.password).not.toBe(password);
  await bindings.DRAWINGS.exec(await adminSQL(' OWNER@example.com ', 'replacement-password', 'Replacement'));
  expect(await bindings.DRAWINGS.prepare('SELECT * FROM auth_user').first()).toEqual(owner);
  expect(await bindings.DRAWINGS.prepare('SELECT * FROM auth_account').first()).toEqual(account);
  const cookie = await login();
  expect((await request('/api/drawings', 'GET', undefined, cookie)).status).toBe(200);
  expect(await bindings.DRAWINGS.prepare('SELECT COUNT(*) AS count FROM auth_user').first()).toEqual({ count: 1 });
});

it('denies every drawing operation without a session and fails closed without configuration', async () => {
  for (const [path, method] of [['/api/drawings', 'GET'], ['/api/drawings', 'POST'], ...['GET', 'PUT', 'DELETE'].map((method) => ['/api/drawings/00000000-0000-0000-0000-000000000000', method])]) {
    expect((await request(path, method)).status).toBe(401);
  }
  expect((await worker.fetch(new Request(`${base}/api/drawings`), { ...bindings, AUTH_EMAIL: '' })).status).toBe(503);
});

it('rejects other emails, unsupported auth routes and cross-origin login', async () => {
  expect((await request('/api/auth/sign-in/email', 'POST', { email: 'stranger@example.com', password })).status).toBe(403);
  expect((await request('/api/auth/sign-up/email', 'POST', { email: 'owner@example.com', password, name: 'Intruder' })).status).toBe(404);
  expect((await request('/api/auth/sign-in/email-otp', 'POST', { email: 'owner@example.com', otp: '123456' })).status).toBe(404);
  expect((await request('/api/auth/sign-in/email', 'POST', { email: 'owner@example.com', password }, undefined, 'https://evil.example')).status).toBe(403);
});

it('preserves drawing CRUD, persists owner sessions and revokes on sign-out', async () => {
  const cookie = await login();
  const session = await (await request('/api/auth/get-session', 'GET', undefined, cookie)).json() as { user: { emailVerified: boolean } };
  expect(session.user.emailVerified).toBe(false);
  expect((await request('/api/drawings', 'POST', undefined, cookie, 'https://evil.example')).status).toBe(403);
  const created = await request('/api/drawings', 'POST', undefined, cookie);
  expect(created.status).toBe(201);
  const drawing = await created.json() as { id: string };
  const path = `/api/drawings/${drawing.id}`;
  const scene = { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} };
  expect((await request(path, 'PUT', { title: 'Private sketch', scene, revision: 0 }, cookie)).status).toBe(200);
  expect(await (await request('/api/drawings', 'GET', undefined, cookie)).json()).toEqual([expect.objectContaining({ title: 'Private sketch' })]);
  expect(await (await request(path, 'GET', undefined, cookie)).json()).toMatchObject({ title: 'Private sketch', scene });
  expect((await request(path, 'DELETE', undefined, cookie)).status).toBe(204);
  await bindings.DRAWINGS.prepare('UPDATE auth_user SET email = ?').bind('stranger@example.com').run();
  expect((await request('/api/drawings', 'GET', undefined, cookie)).status).toBe(403);
  await bindings.DRAWINGS.prepare('UPDATE auth_user SET email = ?').bind('owner@example.com').run();
  expect((await request('/api/auth/sign-out', 'POST', {}, cookie)).status).toBe(200);
  expect((await request('/api/drawings', 'GET', undefined, cookie)).status).toBe(401);
});

it('expires sessions after seven days without sliding renewal and rejects forged cookies', async () => {
  const cookie = await login();
  expect((await request('/api/drawings', 'GET', undefined, `${cookie}tampered`)).status).toBe(401);
  const session = await bindings.DRAWINGS.prepare('SELECT createdAt, expiresAt FROM auth_session').first<{ createdAt: string; expiresAt: string }>();
  expect(new Date(session!.expiresAt).getTime() - new Date(session!.createdAt).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  const nearExpiry = new Date(Date.now() + 60_000).toISOString();
  await bindings.DRAWINGS.prepare('UPDATE auth_session SET expiresAt = ?, updatedAt = ?').bind(nearExpiry, new Date(0).toISOString()).run();
  expect((await request('/api/drawings', 'GET', undefined, cookie)).status).toBe(200);
  expect((await bindings.DRAWINGS.prepare('SELECT expiresAt FROM auth_session').first())!.expiresAt).toBe(nearExpiry);
  await bindings.DRAWINGS.prepare('UPDATE auth_session SET expiresAt = ?').bind(new Date(Date.now() - 1).toISOString()).run();
  expect((await request('/api/drawings', 'GET', undefined, cookie)).status).toBe(401);
});

it('rejects wrong passwords and persists login rate limits across requests', async () => {
  for (let i = 0; i < 5; i++) {
    expect((await request('/api/auth/sign-in/email', 'POST', { email: 'owner@example.com', password: 'wrong-password' })).status).toBe(401);
  }
  expect((await request('/api/auth/sign-in/email', 'POST', { email: 'owner@example.com', password })).status).toBe(429);
  expect((await request('/api/drawings')).status).toBe(401);
});

const emptyScene = { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} };

async function createDrawing(cookie: string) {
  const drawing = await (await request('/api/drawings', 'POST', undefined, cookie)).json() as { id: string; revision: number };
  return { ...drawing, path: `/api/drawings/${drawing.id}` };
}

it('roundtrips embedded images and rejects malformed documents without replacing the committed version', async () => {
  const cookie = await login();
  const { path } = await createDrawing(cookie);
  const image = { id: 'image-element', type: 'image', x: 12, y: -34, width: 80, height: 40, angle: 0, isDeleted: false, fileId: 'image-file' };
  const file = { id: 'image-file', mimeType: 'image/png', created: 123, dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGJ8AAAAASUVORK5CYII=' };
  const scene = { ...emptyScene, elements: [image], files: { 'image-file': file }, source: 'test', appState: { viewBackgroundColor: '#ffeedd' } };
  expect((await request(path, 'PUT', { title: 'With image', scene, revision: 0 }, cookie)).status).toBe(200);
  const committed = await (await request(path, 'GET', undefined, cookie)).json();
  expect(committed).toMatchObject({ revision: 1, title: 'With image', scene });
  for (const invalid of [
    { elements: [] }, { ...scene, type: 'other' }, { ...scene, version: 99 },
    { ...scene, appState: [] }, { ...scene, files: [] }, { ...scene, elements: [null] },
    { ...scene, elements: [{ ...image, x: '12' }] }, { ...scene, elements: [image, image] },
    { ...scene, files: {} }, { ...scene, files: { 'image-file': { ...file, dataURL: 'https://example.com/image.png' } } },
    { ...scene, elements: [{ ...image, type: 'line', points: [[0, 'bad']] }] },
  ]) {
    expect((await request(path, 'PUT', { title: 'Invalid', scene: invalid, revision: 1 }, cookie)).status).toBe(400);
    expect(await (await request(path, 'GET', undefined, cookie)).json()).toEqual(committed);
  }
  expect((await request(path, 'PUT', { title: 'No revision', scene }, cookie)).status).toBe(400);
});

it('preserves the last committed scene when R2 or the D1 commit fails', async () => {
  const cookie = await login();
  const { path } = await createDrawing(cookie);
  const before = await (await request(path, 'GET', undefined, cookie)).json();
  const body = { title: 'Failed save', scene: { ...emptyScene, appState: { viewBackgroundColor: '#123456' } }, revision: 0 };
  vi.spyOn(bindings.FILES, 'put').mockRejectedValueOnce(new Error('R2 unavailable'));
  expect((await request(path, 'PUT', body, cookie)).status).toBe(503);
  expect(await (await request(path, 'GET', undefined, cookie)).json()).toEqual(before);
  const prepare = bindings.DRAWINGS.prepare.bind(bindings.DRAWINGS);
  vi.spyOn(bindings.DRAWINGS, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.startsWith('UPDATE drawings SET title')) {
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, 'bind').mockImplementation((...values) => {
        const bound = bind(...values);
        vi.spyOn(bound, 'run').mockRejectedValueOnce(new Error('D1 unavailable'));
        return bound;
      });
    }
    return statement;
  });
  expect((await request(path, 'PUT', body, cookie)).status).toBe(503);
  expect(await (await request(path, 'GET', undefined, cookie)).json()).toEqual(before);
});

it('keeps the committed object if D1 commits but its acknowledgement fails', async () => {
  const cookie = await login();
  const { path } = await createDrawing(cookie);
  const scene = { ...emptyScene, appState: { viewBackgroundColor: '#987654' } };
  const prepare = bindings.DRAWINGS.prepare.bind(bindings.DRAWINGS);
  vi.spyOn(bindings.DRAWINGS, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.startsWith('UPDATE drawings SET title')) {
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, 'bind').mockImplementation((...values) => {
        const bound = bind(...values);
        const run = bound.run.bind(bound);
        vi.spyOn(bound, 'run').mockImplementationOnce(async () => {
          await run();
          throw new Error('Acknowledgement lost');
        });
        return bound;
      });
    }
    return statement;
  });
  expect((await request(path, 'PUT', { title: 'Committed', scene, revision: 0 }, cookie)).status).toBe(503);
  expect(await (await request(path, 'GET', undefined, cookie)).json()).toMatchObject({ title: 'Committed', scene, revision: 1 });
});

it('rejects a racing save and a stale tab without mixing document content and title', async () => {
  const cookie = await login();
  const { path } = await createDrawing(cookie);
  const put = bindings.FILES.put.bind(bindings.FILES);
  const winningScene = { ...emptyScene, appState: { viewBackgroundColor: '#112233' } };
  vi.spyOn(bindings.FILES, 'put').mockImplementationOnce(async (...args) => {
    const stored = await put(...args);
    expect((await request(path, 'PUT', { title: 'Winner', scene: winningScene, revision: 0 }, cookie)).status).toBe(200);
    return stored;
  });
  expect((await request(path, 'PUT', { title: 'Loser', scene: emptyScene, revision: 0 }, cookie)).status).toBe(409);
  expect(await (await request(path, 'GET', undefined, cookie)).json()).toMatchObject({ title: 'Winner', scene: winningScene, revision: 1 });
  expect((await request(path, 'PUT', { title: 'Stale tab', scene: emptyScene, revision: 0 }, cookie)).status).toBe(409);
  expect((await request(path, 'PUT', { title: 'Next version', scene: emptyScene, revision: 1 }, cookie)).status).toBe(200);
  expect(await (await request(path, 'GET', undefined, cookie)).json()).toMatchObject({ title: 'Next version', scene: emptyScene, revision: 2 });
});

it('never reports a save as successful after a racing deletion', async () => {
  const cookie = await login();
  const { id, path } = await createDrawing(cookie);
  const put = bindings.FILES.put.bind(bindings.FILES);
  vi.spyOn(bindings.FILES, 'put').mockImplementationOnce(async (...args) => {
    expect((await request(path, 'DELETE', undefined, cookie)).status).toBe(204);
    return put(...args);
  });
  expect((await request(path, 'PUT', { title: 'Deleted', scene: emptyScene, revision: 0 }, cookie)).status).toBe(409);
  expect((await request(path, 'GET', undefined, cookie)).status).toBe(404);
  expect((await bindings.FILES.list({ prefix: `drawings/${id}/` })).objects).toEqual([]);
});

it('retries failed deletion, blocks saves to tombstones, and removes all retained versions', async () => {
  const cookie = await login();
  const { id, path } = await createDrawing(cookie);
  for (let revision = 0; revision < 2; revision++) {
    expect((await request(path, 'PUT', { title: `Version ${revision}`, scene: emptyScene, revision }, cookie)).status).toBe(200);
  }
  expect((await bindings.FILES.list({ prefix: `drawings/${id}/` })).objects).toHaveLength(2);
  const list = bindings.FILES.list.bind(bindings.FILES);
  vi.spyOn(bindings.FILES, 'list').mockImplementation((options) => list({ ...options, limit: 1 }));
  vi.spyOn(bindings.FILES, 'delete').mockRejectedValueOnce(new Error('Cleanup unavailable'));
  const failed = await request(path, 'DELETE', undefined, cookie);
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ error: expect.stringContaining('Retry Delete') });
  expect(await bindings.DRAWINGS.prepare('SELECT deleted FROM drawings WHERE id = ?').bind(id).first()).toEqual({ deleted: 1 });
  expect(await (await request('/api/drawings', 'GET', undefined, cookie)).json()).toEqual([]);
  expect((await request(path, 'PUT', { title: 'Resurrect', scene: emptyScene, revision: 2 }, cookie)).status).toBe(404);
  expect((await request(path, 'DELETE', undefined, cookie)).status).toBe(204);
  expect((await request(path, 'DELETE', undefined, cookie)).status).toBe(204);
  expect(await bindings.FILES.get(`drawings/${id}.excalidraw`)).toBeNull();
  expect((await bindings.FILES.list({ prefix: `drawings/${id}/` })).objects).toEqual([]);
  expect(await bindings.DRAWINGS.prepare('SELECT id FROM drawings WHERE id = ?').bind(id).first()).toBeNull();
});
