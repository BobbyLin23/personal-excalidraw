import { useEffect, useRef, useState } from 'react';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();

export function Login({ onSignedIn }: { onSignedIn: () => Promise<unknown> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const modal = dialog.current!;
    modal.showModal();
    return () => modal.close();
  }, []);

  async function signIn() {
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password, rememberMe: true });
      if (result.error) throw new Error(result.error.message || 'Could not sign in.');
      await onSignedIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="login">
    <dialog ref={dialog} className="login-card" aria-labelledby="login-title" aria-describedby="login-description" onCancel={(event) => event.preventDefault()}>
      <div className="empty-icon" aria-hidden="true">✳</div>
      <h1 id="login-title">Your ideas, kept private</h1>
      <p id="login-description">Sign in to My drawings with your email and password.</p>
      <form onSubmit={(event) => { event.preventDefault(); void signIn(); }}>
        <label htmlFor="login-email">Email address</label>
        <input id="login-email" autoFocus type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} placeholder="you@example.com" />
        <label htmlFor="login-password">Password</label>
        <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
        {error && <div className="login-error" role="alert">{error}</div>}
        <button className="save" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="login-note">Owner access only. You’ll stay signed in for 7 days.</p>
    </dialog>
  </main>;
}
