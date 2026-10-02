import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import worker from '../worker';
import type { AuthEnv } from '../worker/auth';
import { adminSQL } from '../scripts/init-admin.mjs';

const bindings = env as unknown as AuthEnv & { FILES: R2Bucket; MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const base = 'https://drawings.example.com';
let ip = 0;
let otp = '';

function request(path: string, method = 'GET', body?: unknown, cookie?: string, origin = base) {
  return worker.fetch(new Request(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin, 'cf-connecting-ip': `192.0.2.${ip}`, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), bindings);
}

function mockEmail(status = 200) {
  vi.mocked(fetch).mockImplementationOnce(async (url, options) => {
    expect(url).toBe('https://api.resend.com/emails');
    expect(options?.method).toBe('POST');
    const mail = JSON.parse(options!.body as string);
    expect(mail.to).toEqual(['owner@example.com']);
    otp = /code is (\d{6})/.exec(mail.text)![1];
    return Response.json({ id: 'test-mail' }, { status });
  });
}

async function login() {
  mockEmail();
  expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email: 'Owner@Example.com', type: 'sign-in' })).status).toBe(200);
  const response = await request('/api/auth/sign-in/email-otp', 'POST', { email: 'owner@example.com', otp });
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  expect(response.headers.get('set-cookie')).toContain('Secure');
  return response.headers.get('set-cookie')!.split(';')[0];
}

beforeAll(async () => {
  await applyD1Migrations(bindings.DRAWINGS, bindings.MIGRATIONS);
});
beforeEach(async () => {
  ip++;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected outbound request'); });
  await bindings.DRAWINGS.batch(['auth_session', 'auth_account', 'auth_user', 'auth_verification', 'auth_rate_limit', 'drawings'].map((table) => bindings.DRAWINGS.prepare(`DELETE FROM ${table}`)));
});
afterEach(() => vi.restoreAllMocks());

it('initializes the owner idempotently without bypassing OTP verification', async () => {
  expect(() => adminSQL('not-an-email')).toThrow();
  expect(() => adminSQL('owner@example.com', ' ')).toThrow();
  await bindings.DRAWINGS.prepare(adminSQL(' Owner@Example.com ', "Owner's drawings")).run();
  const owner = await bindings.DRAWINGS.prepare('SELECT * FROM auth_user').first();
  expect(owner).toMatchObject({ email: 'owner@example.com', name: "Owner's drawings", emailVerified: 0 });
  await bindings.DRAWINGS.prepare(adminSQL('owner@example.com', 'Replacement')).run();
  expect(await bindings.DRAWINGS.prepare('SELECT * FROM auth_user').first()).toEqual(owner);
  const cookie = await login();
  expect(await bindings.DRAWINGS.prepare('SELECT id, emailVerified FROM auth_user').first()).toEqual({ id: owner!.id, emailVerified: 1 });
  expect((await request('/api/drawings', 'GET', undefined, cookie)).status).toBe(200);
  await bindings.DRAWINGS.prepare(adminSQL('OWNER@example.com')).run();
  expect(await bindings.DRAWINGS.prepare('SELECT COUNT(*) AS count FROM auth_user').first()).toEqual({ count: 1 });
  expect(await bindings.DRAWINGS.prepare('SELECT emailVerified FROM auth_user').first()).toEqual({ emailVerified: 1 });
});

it('denies every drawing operation without a session and fails closed without configuration', async () => {
  for (const [path, method] of [['/api/drawings', 'GET'], ['/api/drawings', 'POST'], ...['GET', 'PUT', 'DELETE'].map((method) => ['/api/drawings/00000000-0000-0000-0000-000000000000', method])]) {
    expect((await request(path, method)).status).toBe(401);
  }
  expect((await worker.fetch(new Request(`${base}/api/drawings`), { ...bindings, AUTH_EMAIL: '' })).status).toBe(503);
});

it('rejects other emails, unsupported auth routes and cross-origin login', async () => {
  expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email: 'stranger@example.com', type: 'sign-in' })).status).toBe(403);
  expect((await request('/api/auth/sign-in/email-otp', 'POST', { email: 'stranger@example.com', otp: '123456' })).status).toBe(403);
  expect((await request('/api/auth/email-otp/get-verification-otp', 'POST', { email: 'owner@example.com', type: 'sign-in' })).status).toBe(404);
  expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email: 'owner@example.com', type: 'sign-in' }, undefined, 'https://evil.example')).status).toBe(403);
});

it('verifies email, preserves drawing CRUD, persists sessions, prevents replay and revokes on sign-out', async () => {
  const cookie = await login();
  const session = await (await request('/api/auth/get-session', 'GET', undefined, cookie)).json() as { user: { emailVerified: boolean } };
  expect(session.user.emailVerified).toBe(true);
  expect((await request('/api/auth/sign-in/email-otp', 'POST', { email: 'owner@example.com', otp })).status).toBe(400);
  expect((await request('/api/drawings', 'POST', undefined, cookie, 'https://evil.example')).status).toBe(403);
  const created = await request('/api/drawings', 'POST', undefined, cookie);
  expect(created.status).toBe(201);
  const drawing = await created.json() as { id: string };
  const path = `/api/drawings/${drawing.id}`;
  const scene = { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} };
  expect((await request(path, 'PUT', { title: 'Private sketch', scene }, cookie)).status).toBe(200);
  expect(await (await request('/api/drawings', 'GET', undefined, cookie)).json()).toEqual([expect.objectContaining({ title: 'Private sketch' })]);
  expect(await (await request(path, 'GET', undefined, cookie)).json()).toMatchObject({ title: 'Private sketch', scene });
  expect((await request(path, 'DELETE', undefined, cookie)).status).toBe(204);
  await bindings.DRAWINGS.prepare('UPDATE auth_user SET email = ?').bind('stranger@example.com').run();
  expect((await request('/api/drawings', 'GET', undefined, cookie)).status).toBe(403);
  await bindings.DRAWINGS.prepare('UPDATE auth_user SET email = ?, emailVerified = 0').bind('owner@example.com').run();
  expect((await request('/api/drawings', 'GET', undefined, cookie)).status).toBe(403);
  await bindings.DRAWINGS.prepare('UPDATE auth_user SET emailVerified = 1').run();
  expect((await request('/api/auth/sign-out', 'POST', {}, cookie)).status).toBe(200);
  expect((await request('/api/drawings', 'GET', undefined, cookie)).status).toBe(401);
});

it('rejects expired and forged sessions', async () => {
  const cookie = await login();
  expect((await request('/api/drawings', 'GET', undefined, `${cookie}tampered`)).status).toBe(401);
  await bindings.DRAWINGS.prepare('UPDATE auth_session SET expiresAt = 0').run();
  expect((await request('/api/drawings', 'GET', undefined, cookie)).status).toBe(401);
});

it('hashes codes, limits wrong attempts, and rejects expired codes', async () => {
  mockEmail();
  await request('/api/auth/email-otp/send-verification-otp', 'POST', { email: 'owner@example.com', type: 'sign-in' });
  const record = await bindings.DRAWINGS.prepare('SELECT value FROM auth_verification').first<{ value: string }>();
  expect(record!.value).not.toContain(otp);
  const wrong = otp === '000000' ? '999999' : '000000';
  for (let attempt = 0; attempt < 3; attempt++) expect((await request('/api/auth/sign-in/email-otp', 'POST', { email: 'owner@example.com', otp: wrong })).status).toBe(400);
  expect((await request('/api/auth/sign-in/email-otp', 'POST', { email: 'owner@example.com', otp })).status).not.toBe(200);
  ip++;
  mockEmail();
  await request('/api/auth/email-otp/send-verification-otp', 'POST', { email: 'owner@example.com', type: 'sign-in' });
  await bindings.DRAWINGS.prepare('UPDATE auth_verification SET expiresAt = 0').run();
  expect((await request('/api/auth/sign-in/email-otp', 'POST', { email: 'owner@example.com', otp })).status).toBe(400);
});

it('persists rate limits across requests and logs email delivery failure without granting access', async () => {
  for (let i = 0; i < 3; i++) {
    mockEmail();
    expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email: 'owner@example.com', type: 'sign-in' })).status).toBe(200);
  }
  expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email: 'owner@example.com', type: 'sign-in' })).status).toBe(429);
  ip++;
  mockEmail(500);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Better Auth intentionally returns success even if its mail callback fails.
  expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email: 'owner@example.com', type: 'sign-in' })).status).toBe(200);
  expect(log).toHaveBeenCalled();
  expect((await request('/api/drawings')).status).toBe(401);
});
