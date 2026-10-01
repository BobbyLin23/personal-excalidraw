import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import './style.css';

type Drawing = { id: string; title: string; updatedAt: string };
type LoadedDrawing = Drawing & { scene: { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown> } };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const message = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(message.error || `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function App() {
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [current, setCurrent] = useState<LoadedDrawing | null>(null);
  const [title, setTitle] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI | null>(null);
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

  function canLeave() {
    return !dirty || window.confirm('Discard unsaved changes?');
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
        body: JSON.stringify({ title, scene }),
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
      <header className="topbar">
        <div className="brand"><span className="brand-mark">✳</span> My drawings</div>
        <div className="controls">
          <label className="sr-only" htmlFor="drawing-select">Open drawing</label>
          <select id="drawing-select" value={current?.id || ''} disabled={busy} onChange={(event) => void open(event.target.value)}>
            <option value="">Choose a drawing</option>
            {drawings.map((drawing) => <option key={drawing.id} value={drawing.id}>{drawing.title}</option>)}
          </select>
          <button onClick={() => void create()} disabled={busy}>New</button>
          {current && <>
            <input aria-label="Drawing title" maxLength={100} value={title} onChange={(event) => { setTitle(event.target.value); setDirty(event.target.value !== current.title || currentSnapshot.current !== savedSnapshot.current); }} />
            <button className="save" onClick={() => void save()} disabled={busy || !dirty || !title.trim()}>{busy ? 'Working…' : 'Save'}</button>
            <button className="delete" onClick={() => void remove()} disabled={busy}>Delete</button>
          </>}
        </div>
        <span className="status" role="status">{error || (dirty ? 'Unsaved changes' : current ? 'Saved' : '')}</span>
      </header>
      <main>
        {current ? (
          <Excalidraw key={current.id} excalidrawAPI={setEditor}
            initialData={current.scene as React.ComponentProps<typeof Excalidraw>['initialData']}
            onChange={(elements, appState, files) => {
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

createRoot(document.getElementById('root')!).render(<App />);
