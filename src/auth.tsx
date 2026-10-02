import { useState } from 'react';
import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({ plugins: [emailOTPClient()] });

export function Login({ onSignedIn }: { onSignedIn: () => Promise<unknown> }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function sendCode() {
    setBusy(true);
    setError('');
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: 'sign-in' });
      if (result.error) throw new Error(result.error.message || 'Could not send code.');
      setSent(true);
      setOtp('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signIn.emailOtp({ email: email.trim(), otp });
      if (result.error) throw new Error(result.error.message || 'Could not sign in.');
      await onSignedIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="login">
    <section className="login-card" aria-labelledby="login-title">
      <div className="empty-icon" aria-hidden="true">✳</div>
      <h1 id="login-title">{sent ? 'Check your inbox' : 'Your ideas, kept private'}</h1>
      <p>{sent ? `Enter the six-digit code sent to ${email}. It expires in 5 minutes.` : 'Sign in to My drawings with your email. No password needed.'}</p>
      <form onSubmit={(event) => { event.preventDefault(); void (sent ? verify() : sendCode()); }}>
        {sent ? <>
          <label htmlFor="login-code">Sign-in code</label>
          <input key="code" id="login-code" autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={otp} onChange={(event) => setOtp(event.target.value)} disabled={busy} />
        </> : <>
          <label htmlFor="login-email">Email address</label>
          <input key="email" id="login-email" autoFocus type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} placeholder="you@example.com" />
        </>}
        {error && <div className="login-error" role="alert">{error}</div>}
        <button className="save" disabled={busy}>{busy ? 'Please wait…' : sent ? 'Sign in' : 'Send sign-in code'}</button>
      </form>
      {sent && <div className="login-actions">
        <button disabled={busy} onClick={() => void sendCode()}>Resend code</button>
        <button disabled={busy} onClick={() => { setSent(false); setOtp(''); setError(''); }}>Use another email</button>
      </div>}
      <p className="login-note">A private workspace for the owner of this app.</p>
    </section>
  </main>;
}
