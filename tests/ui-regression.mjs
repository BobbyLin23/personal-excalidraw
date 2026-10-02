// Run against a local dev server. Only this browser's API calls are mocked;
// Worker persistence and authentication are covered by the Vitest suite.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function fixture() {
  const fetch = window.fetch.bind(window);
  let signedIn = true;
  const scene = { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} };
  const drawings = [
    { id: '00000000-0000-0000-0000-000000000001', title: 'First drawing', revision: 0, updatedAt: '2026-01-01', scene },
    { id: '00000000-0000-0000-0000-000000000002', title: 'Second drawing', revision: 0, updatedAt: '2026-01-02', scene },
  ];
  window.confirm = () => true;
  window.__calls = [];
  window.fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    if (path === '/api/auth/get-session') return Response.json(signedIn ? {
      user: { id: 'test-user', email: 'owner@example.com', emailVerified: true, name: 'Test owner' },
      session: { id: 'test-session', userId: 'test-user', expiresAt: '2099-01-01T00:00:00Z' },
    } : null);
    if (path === '/api/drawings' && method === 'GET') return Response.json(drawings);
    if (!path.startsWith('/api/')) return fetch(input, init);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    window.__calls.push({ path, method, body });
    return new Promise((resolve) => {
      window.__pending = { path, method, body };
      window.__release = (status = 200) => {
        window.__pending = null;
        if (status !== 200) return resolve(Response.json({ error: 'Drawing changed. Export before reopening.' }, { status }));
        if (path === '/api/auth/sign-out') signedIn = false;
        let drawing = drawings.find((drawing) => path.endsWith(drawing.id));
        if (method === 'POST' && path === '/api/drawings') {
          drawing = { ...drawings[0], id: '00000000-0000-0000-0000-000000000003', title: 'New drawing' };
          drawings.push(drawing);
        }
        if (method === 'PUT') Object.assign(drawing, body, { revision: body.revision + 1 });
        resolve(Response.json(drawing || { success: true }));
      };
    });
  };
}

const dir = mkdtempSync(join(tmpdir(), 'drawing-ui-'));
const initScript = join(dir, 'fixture.js');
writeFileSync(initScript, `(${fixture.toString()})();`);
const browser = (...args) => execFileSync('agent-browser', ['--session', 'drawing-ui', ...args], { encoding: 'utf8', timeout: 30000 }).trim();
const evaluate = (code) => browser('eval', code);
const wait = (code) => browser('wait', '--fn', code);
const assert = (code) => evaluate(`(() => { if (!(${code})) throw new Error(${JSON.stringify(code)}); return 'PASS'; })()`);
const title = 'input[aria-label="Drawing title"]';
const first = '00000000-0000-0000-0000-000000000001';
const second = '00000000-0000-0000-0000-000000000002';
const release = (status = 200) => evaluate(`window.__release(${status})`);
const locked = () => {
  wait('document.querySelector("main").inert && document.querySelector("header input").disabled');
  assert(`['keydown', 'keyup', 'paste', 'cut', 'drop'].every(type => {
    const event = type.startsWith('key') ? new KeyboardEvent(type, { key: 'Delete', bubbles: true, cancelable: true }) : new Event(type, { bubbles: true, cancelable: true });
    return !document.dispatchEvent(event) && event.defaultPrevented;
  })`);
};

try {
  browser('--init-script', initScript, 'open', process.argv[2] || 'http://localhost:5173');
  browser('set', 'viewport', '1280', '720', '2');
  wait('document.querySelector("#drawing-select")?.options.length === 3');
  browser('select', '#drawing-select', first);
  wait('window.__pending?.method === "GET"');
  release();
  wait('!!document.querySelector(".excalidraw canvas")');
  browser('fill', title, 'Edited first');
  browser('click', 'label[title^="Rectangle"]');
  browser('mouse', 'move', '500', '300');
  browser('mouse', 'down', 'left');
  browser('mouse', 'move', '640', '380');
  browser('mouse', 'up', 'left');
  browser('click', 'button.save');
  wait('window.__pending?.method === "PUT"');
  locked();
  assert('window.__pending.body.revision === 0 && window.__pending.body.scene.elements.length === 1');
  // Pointer drawing and document shortcuts must not alter the pending document.
  browser('press', 'Delete');
  browser('mouse', 'move', '700', '400');
  browser('mouse', 'down', 'left');
  browser('mouse', 'move', '800', '500');
  browser('mouse', 'up', 'left');
  const artifact = process.env.UI_SCREENSHOT;
  if (artifact) {
    mkdirSync(resolve(artifact, '..'), { recursive: true });
    browser('screenshot', resolve(artifact));
  }
  release();
  wait('!document.querySelector("main").inert && document.querySelector(".status").textContent === "Saved"');
  browser('fill', title, 'After save');
  browser('click', 'button.save');
  wait('window.__pending?.method === "PUT"');
  assert('window.__pending.body.revision === 1 && window.__pending.body.scene.elements.length === 1');
  release(409);
  wait('document.querySelector(".status").textContent.includes("Export")');
  assert('!document.querySelector("button.save").disabled && !document.querySelector("main").inert');
  browser('select', '#drawing-select', second);
  wait('window.__pending?.method === "GET"');
  locked();
  release(500);
  wait('!document.querySelector("main").inert');
  assert('document.querySelector("header input").value === "After save"');
  browser('select', '#drawing-select', second);
  wait('window.__pending?.method === "GET"');
  locked();
  release();
  wait('document.querySelector("header input").value === "Second drawing"');
  browser('click', '.controls > button:first-of-type');
  wait('window.__pending?.method === "POST"');
  locked();
  release();
  wait('window.__pending?.method === "GET"');
  locked();
  release();
  wait('document.querySelector("header input").value === "New drawing"');
  browser('click', 'header > button');
  wait('window.__pending?.path === "/api/auth/sign-out"');
  locked();
  release(500);
  wait('!document.querySelector("main").inert');
  assert('!document.querySelector("header input").disabled');
  browser('click', 'button.delete');
  wait('window.__pending?.method === "DELETE"');
  locked();
  release(503);
  wait('!document.querySelector("main").inert');
  assert('document.querySelector("header input").value === "New drawing"');
  browser('click', 'header > button');
  wait('window.__pending?.path === "/api/auth/sign-out"');
  locked();
  release();
  wait('!!document.querySelector("#login-email")');
  console.log('PASS: save/open/create/delete/sign-out lock pointer and keyboard editing; revisions advance; conflicts and failures retain editable work.');
} catch (error) {
  console.error(browser('snapshot', '-i'));
  console.error(browser('errors'));
  console.error(evaluate('window.__calls'));
  throw error;
} finally {
  browser('close');
  rmSync(dir, { recursive: true, force: true });
}
