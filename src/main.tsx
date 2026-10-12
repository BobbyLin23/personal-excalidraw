import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { Button, ListBox, ListBoxItem, Popover, Select, SelectValue } from 'react-aria-components';
import { authClient, Login } from './auth';
import '@excalidraw/excalidraw/index.css';
import './style.css';

type Theme = 'light' | 'dark';
type Drawing = { id: string; title: string; updatedAt: string; revision: number };
type LoadedDrawing = Drawing & { scene: { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown> } };

const THEME_KEY = 'theme';
const storedTheme = localStorage.getItem(THEME_KEY);
const initialTheme: Theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme
  : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
document.documentElement.dataset.theme = initialTheme;
// Ctrl/Cmd+S saves to this app instead of Excalidraw's local-file save.
const UI_OPTIONS = { canvasActions: { toggleTheme: true, saveToActiveFile: false } };
const isSaveShortcut = (event: KeyboardEvent) => (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's';
const HEADER_KEYS = new Set(['Enter', ' ', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const message = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(message.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function App({ onSignOut }: { onSignOut: () => void }) {
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [current, setCurrent] = useState<LoadedDrawing | null>(null);
  const [title, setTitle] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const editorTheme = useRef<Theme | null>(null);
  const savedSnapshot = useRef<string | null>(null);
  const currentSnapshot = useRef<string | null>(null);

  useEffect(() => {
    api<Drawing[]>('/api/drawings').then(setDrawings).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      if (dirty && title.trim()) void save();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    if (!busy) return;
    // Excalidraw listens on document, so inert alone does not block its shortcuts.
    const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const events = ['keydown', 'keyup', 'paste', 'cut', 'drop'];
    events.forEach((name) => window.addEventListener(name, block, true));
    return () => events.forEach((name) => window.removeEventListener(name, block, true));
  }, [busy]);

  function canLeave() {
    return !dirty || window.confirm('Discard unsaved changes?');
  }

  async function signOut() {
    if (busy || !canLeave()) return;
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || 'Could not sign out.');
      onSignOut();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    if (busy || id === current?.id || !canLeave()) return;
    setBusy(true);
    setError('');
    try {
      const drawing = await api<LoadedDrawing>(`/api/drawings/${id}`);
      setEditor(null);
      savedSnapshot.current = null;
      currentSnapshot.current = null;
      setCurrent(drawing);
      setTitle(drawing.title);
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (busy || !canLeave()) return;
    setBusy(true);
    setError('');
    try {
      const drawing = await api<Drawing>('/api/drawings', { method: 'POST' });
      setDrawings((items) => [drawing, ...items]);
      const loaded = await api<LoadedDrawing>(`/api/drawings/${drawing.id}`);
      setEditor(null);
      savedSnapshot.current = null;
      currentSnapshot.current = null;
      setCurrent(loaded);
      setTitle(loaded.title);
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!current || !editor || busy) return;
    setBusy(true);
    setError('');
    try {
      const snapshot = serializeAsJSON(editor.getSceneElements(), editor.getAppState(), editor.getFiles(), 'local');
      const scene = JSON.parse(snapshot);
      const saved = await api<Drawing>(`/api/drawings/${current.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, scene, revision: current.revision }),
      });
      setCurrent({ ...current, ...saved, scene });
      setDrawings((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      savedSnapshot.current = snapshot;
      setDirty(currentSnapshot.current !== snapshot || title !== saved.title);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!current || busy || !window.confirm(`Delete “${current.title}” permanently?`)) return;
    setBusy(true);
    setError('');
    try {
      await api<void>(`/api/drawings/${current.id}`, { method: 'DELETE' });
      setDrawings((items) => items.filter((item) => item.id !== current.id));
      setEditor(null);
      savedSnapshot.current = null;
      currentSnapshot.current = null;
      setCurrent(null);
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      {/* Excalidraw handles shortcuts on document; keep header navigation keys and list typeahead from reaching the canvas. */}
      <header className="topbar" onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (HEADER_KEYS.has(event.key) || (event.target as Element).closest('[role="listbox"]')) event.stopPropagation();
      }}>
        <div className="brand"><span className="brand-mark">✳</span> My drawings</div>
        <div className="controls">
          <Select className="drawing-select" aria-label="Open drawing" placeholder="Choose a drawing"
            selectedKey={current?.id ?? null} isDisabled={busy} allowsEmptyCollection
            onSelectionChange={(key) => { if (key !== null) void open(String(key)); }}>
            <Button className="drawing-select-trigger">
              <SelectValue className="drawing-select-value" />
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </Button>
            <Popover className="drawing-select-popover" placement="bottom start" offset={6}>
              <ListBox className="drawing-select-list" items={drawings} renderEmptyState={() => <div className="drawing-select-empty">No drawings yet</div>}>
                {(drawing) => <ListBoxItem className="drawing-select-option" id={drawing.id} textValue={drawing.title}>
                  {({ isSelected }) => <><span className="drawing-select-title">{drawing.title}</span><span className="drawing-select-check" aria-hidden="true">{isSelected ? '✓' : ''}</span></>}
                </ListBoxItem>}
              </ListBox>
            </Popover>
          </Select>
          <button onClick={() => void create()} disabled={busy}>New</button>
          {current && <>
            <input aria-label="Drawing title" disabled={busy} maxLength={100} value={title} onChange={(event) => { setTitle(event.target.value); setDirty(event.target.value !== current.title || currentSnapshot.current !== savedSnapshot.current); }} />
            <button className="save" onClick={() => void save()} disabled={busy || !dirty || !title.trim()}>{busy ? 'Working…' : 'Save'}</button>
            <button className="delete" onClick={() => void remove()} disabled={busy}>Delete</button>
          </>}
        </div>
        <span className="status" role="status">{error || (dirty ? 'Unsaved changes' : current ? 'Saved' : '')}</span>
        <button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={`${theme === 'dark' ? 'Light' : 'Dark'} mode (Shift+Alt+D)`}>
          {theme === 'dark'
            ? <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            : <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>}
        </button>
        <button disabled={busy} onClick={() => void signOut()}>Sign out</button>
      </header>
      <main aria-busy={busy} {...(busy ? { inert: '' } : {})}>
        {current ? (
          <Excalidraw key={current.id} excalidrawAPI={setEditor} theme={theme} UIOptions={UI_OPTIONS} handleKeyboardGlobally
            initialData={current.scene as React.ComponentProps<typeof Excalidraw>['initialData']}
            onChange={(elements, appState, files) => {
              // Follow Excalidraw's own theme toggle; ignore the stale theme it reports while applying a prop change.
              if (appState.theme !== editorTheme.current) {
                editorTheme.current = appState.theme;
                setTheme(appState.theme);
              }
              const snapshot = serializeAsJSON(elements, appState, files, 'local');
              if (savedSnapshot.current === null) savedSnapshot.current = snapshot;
              currentSnapshot.current = snapshot;
              setDirty(snapshot !== savedSnapshot.current || title !== current.title);
            }} />
        ) : <div className="empty">
          <div className="empty-icon">✳</div>
          <h1>{loading ? 'Loading drawings…' : 'A space for your ideas'}</h1>
          <p>{error || 'Create a drawing or pick one above. Save when you are ready.'}</p>
          {!loading && <button className="save" onClick={() => void create()} disabled={busy}>Create a drawing</button>}
        </div>}
      </main>
    </div>
  );
}

function AuthenticatedApp() {
  const { data: session, isPending, error, refetch } = authClient.useSession();
  // Keep an open editor mounted if the session expires, so unsaved work can be exported.
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => { if (session) setSignedIn(true); }, [session]);
  if (signedIn || session) return <App onSignOut={() => setSignedIn(false)} />;
  if (isPending) return <main className="empty"><h1>Checking your session…</h1></main>;
  if (error) return <main className="empty"><h1>Unable to check your session</h1><p role="alert">{error.message || 'Authentication is unavailable. Check the server configuration and try again.'}</p><button onClick={() => void refetch()}>Try again</button></main>;
  return <Login onSignedIn={refetch} />;
}

createRoot(document.getElementById('root')!).render(<AuthenticatedApp />);
