import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import './styles.css';

class ApiRequestError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(message: string, code = 'REQUEST_ERROR', details: unknown = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

type ApiOptions = Omit<RequestInit, 'body' | 'headers' | 'credentials'> & {
  body?: unknown;
  headers?: HeadersInit;
  _csrfRetry?: boolean;
};

let csrfToken: string | null = null;

async function obtainCsrfToken(): Promise<string> {
  const response = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
  const body: any = await response.json().catch(() => null);
  if (!response.ok || !body?.csrfToken) throw new ApiRequestError('Could not start a protected browser session. Refresh and try again.', 'CSRF_BOOTSTRAP_FAILED');
  csrfToken = String(body.csrfToken);
  return csrfToken;
}

function clearCsrfToken(): void { csrfToken = null; }

async function api<T = any>(url: string, options: ApiOptions = {}): Promise<T> {
  const { _csrfRetry = false, body: requestBody, headers: suppliedHeaders, ...transportOptions } = options;
  const headers = new Headers(suppliedHeaders);
  const request: RequestInit = { credentials: 'same-origin', ...transportOptions };
  const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(request.method || 'GET').toUpperCase());
  if (unsafe && url !== '/api/auth/csrf') headers.set('X-CSRF-Token', csrfToken || await obtainCsrfToken());
  if (requestBody !== undefined) {
    if (typeof requestBody === 'string' || requestBody instanceof FormData || requestBody instanceof Blob || requestBody instanceof URLSearchParams) {
      request.body = requestBody;
    } else {
      headers.set('Content-Type', 'application/json');
      request.body = JSON.stringify(requestBody);
    }
  }
  if ([...headers.keys()].length) request.headers = headers;
  const response = await fetch(url, request);
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const body: any = isJson ? await response.json() : null;
  if (!response.ok) {
    if (body?.error?.code === 'CSRF_INVALID' && !_csrfRetry) {
      clearCsrfToken();
      return api<T>(url, { ...transportOptions, body: requestBody, headers: suppliedHeaders, _csrfRetry: true });
    }
    throw new ApiRequestError(body?.error?.message || 'Something went wrong. Please try again.', body?.error?.code, body?.error?.details);
  }
  return body as T;
}

const icons = {
  droplet: 'M12 2.8c-2.8 4-6.6 8.1-6.6 12.1a6.6 6.6 0 0 0 13.2 0C18.6 10.9 14.8 6.8 12 2.8Z',
  grid: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
  people: 'M16 20v-1.7a4.3 4.3 0 0 0-4.3-4.3H6.3A4.3 4.3 0 0 0 2 18.3V20m17-6a3.2 3.2 0 0 1 3 3.2V20m-6-14a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM9 4a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z',
  calendar: 'M7 3v3m10-3v3M4 9h16M5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5Z',
  send: 'm21 3-7.3 18-3.8-8.1L3 9.2 21 3Zm-11 9.9L21 3',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm8.3-3.2c0-.6-.1-1.2-.2-1.7l1.8-1.4-1.9-3.2-2.1.8a8.3 8.3 0 0 0-3-1.7L14.6 2h-3.7l-.4 2.8a8.3 8.3 0 0 0-3 1.7l-2.1-.8-1.9 3.2 1.8 1.4A7.8 7.8 0 0 0 5.1 12c0 .6.1 1.2.2 1.7l-1.8 1.4 1.9 3.2 2.1-.8a8.3 8.3 0 0 0 3 1.7l.4 2.8h3.7l.4-2.8a8.3 8.3 0 0 0 3-1.7l2.1.8 1.9-3.2-1.8-1.4c.1-.5.2-1.1.2-1.7Z',
  shield: 'M12 3 20 6v5.6c0 4.7-3.2 7.8-8 9.4-4.8-1.6-8-4.7-8-9.4V6l8-3Zm-3.2 9 2.1 2.1 4.3-4.5',
  plus: 'M12 5v14M5 12h14',
  search: 'm20 20-4.3-4.3m1.3-4.7a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  bell: 'M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8.2 12h4.4',
  arrowRight: 'M5 12h14m-6-6 6 6-6 6',
  chevronRight: 'm9 18 6-6-6-6',
  arrowUpRight: 'M7 17 17 7m-7 0h7v7',
  check: 'm5 12 4.2 4.2L19 6.5',
  alert: 'M12 3 2.7 20h18.6L12 3Zm0 6v4m0 4h.01',
  clock: 'M12 6v6l4 2',
  lock: 'M7 10V8a5 5 0 0 1 10 0v2m-11 0h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z',
  phone: 'M7.1 3.2 5.5 4.8c-.8.8-.7 3.1.4 5.5a16 16 0 0 0 7.8 7.8c2.4 1.1 4.7 1.2 5.5.4l1.6-1.6-3.1-2.6-1.8 1.4c-2.1-.8-4.6-3.3-5.4-5.4l1.4-1.8-2.8-3.3Z',
  whatsapp: 'M20.5 11.9a8.5 8.5 0 0 1-12.6 7.4L3 20.7l1.4-4.7A8.5 8.5 0 1 1 20.5 11.9Zm-4.8 3.7c-.2.5-1.2.9-1.6.9-.4.1-.8.1-1.3-.1-.3-.1-.8-.3-1.3-.5-2.2-1-3.6-3.3-3.7-3.4-.1-.2-.9-1.2-.9-2.3s.6-1.7.8-1.9c.2-.2.4-.3.6-.3h.4c.1 0 .3 0 .4.3l.6 1.4c.1.3 0 .4 0 .5-.1.1-.2.3-.3.4l-.3.4c-.1.1-.2.3-.1.5.1.2.6 1 1.3 1.6.9.8 1.7 1.1 1.9 1.2.2.1.4.1.5-.1l.6-.7c.2-.2.3-.2.5-.1l1.3.6c.2.1.3.2.4.3.1.2.1.8-.1 1.3Z',
  download: 'M12 3v11m0 0 4-4m-4 4-4-4M5 20h14',
  upload: 'M12 16V5m0 0 4 4m-4-4L8 9M5 20h14',
  refresh: 'M20 11a8 8 0 0 0-14.9-3.9L3 9m0-5v5h5m-4 4a8 8 0 0 0 14.9 3.9L21 15m0 5v-5h-5',
  x: 'm6 6 12 12M18 6 6 18',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  file: 'M6 3h8l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 0v5h5',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  logout: 'M10 17l5-5-5-5m5 5H3m10-8h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5',
  info: 'M12 8h.01M11 12h1v4h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  archive: 'M4 7h16v13H4V7Zm-1-3h18v3H3V4Zm7 7h4',
  filter: 'M4 5h16M7 12h10m-7 7h4',
};

function Icon({ name, size = 18, className = '' }) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name] || icons.info} /></svg>;
}

function Avatar({ name = '', small = false }) {
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'LW';
  return <span className={`avatar ${small ? 'avatar-small' : ''}`}>{initials}</span>;
}

function Badge({ children, tone = 'neutral', icon = null }) {
  return <span className={`badge badge-${tone}`}>{icon && <Icon name={icon} size={13} />}{children}</span>;
}

function Button({ children, variant = 'primary', icon = null, className = '', loading = false, ...props }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{loading ? <span className="button-spinner" /> : icon ? <Icon name={icon} size={17} /> : null}{children}</button>;
}

function formatDate(date, options = {}) {
  if (!date) return '—';
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00+01:00` : date;
  return new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric', ...options }).format(new Date(normalized));
}

function formatTime(date) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-NG', { hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}

function dateLabel(item) {
  if (item.daysUntil === 0) return 'Today';
  if (item.daysUntil === 1) return 'Tomorrow';
  return formatDate(item.occurrenceDate, { weekday: 'short' });
}

function humanTime(date) {
  if (!date) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function channelLabel(channel) {
  return channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
}

function statusTone(status) {
  if (['delivered', 'read'].includes(status)) return 'success';
  if (['failed', 'dead_letter'].includes(status)) return 'danger';
  if (['queued', 'scheduled', 'retrying'].includes(status)) return 'warning';
  return 'info';
}

function statusLabel(status) {
  return String(status || '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function useRemoteData(url, refreshKey = 0) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  useEffect(() => {
    let live = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    api(url).then((data) => {
      if (live) setState({ loading: false, error: null, data });
    }).catch((error) => {
      if (live) setState({ loading: false, error, data: null });
    });
    return () => { live = false; };
  }, [url, refreshKey]);
  return state;
}

function LoadingBlock({ rows = 3 }) {
  return <div className="loading-stack" aria-label="Loading"><span className="skeleton skeleton-title" />{Array.from({ length: rows }).map((_, index) => <span className="skeleton" key={index} />)}</div>;
}

function EmptyState({ icon = 'calendar', title, body, action = null }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={24} /></span><h3>{title}</h3>{body && <p>{body}</p>}{action}</div>;
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(onClose, 4600);
    return () => window.clearTimeout(timer);
  }, [toast, onClose]);
  if (!toast) return null;
  return <div className={`toast toast-${toast.tone || 'success'}`} role="status"><Icon name={toast.tone === 'danger' ? 'alert' : toast.tone === 'info' ? 'info' : 'check'} size={18} /><span>{toast.message}</span><button onClick={onClose} aria-label="Dismiss notification"><Icon name="x" size={17} /></button></div>;
}

function Modal({ title, subtitle, children, onClose, wide = false }) {
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header className="modal-head"><div><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="x" /></button></header>
      {children}
    </section>
  </div>;
}

function LoginScreen({ onSignedIn, onMfaRequired }) {
  const [accounts, setAccounts] = useState([]);
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/auth/demo-accounts').then((result) => {
      setAccounts(result.accounts || []);
      setPassword(result.password || '');
      if (result.accounts?.[0]) setEmail('owner@livingwater.demo');
    }).catch(() => setAccounts([]));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: { email, password } });
      if (result.requiresMfa) onMfaRequired(result);
      else onSignedIn(result.user);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  async function signInWithPasskey() {
    setError('');
    setPasskeyLoading(true);
    try {
      const optionsResult = await api('/api/auth/passkey/options', { method: 'POST', body: { email } });
      const response = await startAuthentication({ optionsJSON: optionsResult.options });
      const result = await api('/api/auth/passkey/verify', { method: 'POST', body: { response } });
      onSignedIn(result.user);
    } catch (requestError) {
      setError(requestError.message || 'Your passkey could not be used.');
    } finally {
      setPasskeyLoading(false);
    }
  }

  return <main className="login-shell">
    <section className="login-intro">
      <div className="login-brand"><span className="brand-mark"><Icon name="droplet" size={25} /></span><span>Living Water</span></div>
      <div className="intro-content">
        <Badge tone="aqua" icon="shield">Private member care</Badge>
        <h1>Every birthday, <em>remembered</em> with care.</h1>
        <p>A secure operations dashboard for Living Water Mega Parish – RCCG. Coordinate birthday care without exposing a member directory in chat groups.</p>
        <div className="intro-proof">
          <span><Icon name="lock" size={18} /> Permission-aware</span>
          <span><Icon name="bell" size={18} /> Reliable alerts</span>
          <span><Icon name="shield" size={18} /> MFA-ready</span>
        </div>
      </div>
      <div className="water-orb orb-one" /><div className="water-orb orb-two" />
      <p className="copyright">© {new Date().getFullYear()} Living Water Mega Parish – RCCG</p>
    </section>
    <section className="login-panel-wrap">
      <div className="login-panel">
        {accounts.length > 0 && <div className="demo-note"><Icon name="info" size={17} /><span><strong>Safe demonstration</strong><br />This workspace uses seeded sample members and mock delivery. Never use these credentials in production.</span></div>}
        <div className="panel-heading"><span className="eyebrow">Staff access</span><h2>Welcome back</h2><p>Sign in to your private birthday-care workspace.</p></div>
        <form className="login-form" onSubmit={submit}>
          <label>Email address<input type="email" autoComplete="email webauthn" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@church.org" required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {error && <div className="form-alert"><Icon name="alert" size={16} />{error}</div>}
          <Button type="submit" className="full-width" loading={loading} icon="arrowRight">Secure sign in</Button>
        </form>
        <div className="login-divider"><span>or</span></div>
        <Button type="button" variant="secondary" className="full-width login-passkey" loading={passkeyLoading} icon="lock" onClick={signInWithPasskey}>Sign in with passkey</Button>
        {accounts.length > 0 && <><div className="login-divider"><span>Demo roles</span></div><div className="account-picker">
          {accounts.map((account) => <button type="button" key={account.email} className={`demo-account ${email === account.email ? 'selected' : ''}`} onClick={() => setEmail(account.email)}>
            <Avatar name={account.name} small /><span><strong>{account.name}</strong><small>{account.roleLabel}</small></span><Icon name="chevronRight" size={16} />
          </button>)}
        </div></>}
        <p className="login-footnote"><Icon name="shield" size={14} /> Production access uses staff invitations plus an authenticator app or a verified passkey.</p>
      </div>
    </section>
  </main>;
}

function AuthShell({ eyebrow = 'Secure staff access', title, body, children, aside = null }) {
  return <main className="login-shell auth-shell">
    <section className="login-intro">
      <div className="login-brand"><span className="brand-mark"><Icon name="droplet" size={25} /></span><span>Living Water</span></div>
      <div className="intro-content"><Badge tone="aqua" icon="shield">{eyebrow}</Badge><h1>{title}</h1><p>{body}</p><div className="intro-proof"><span><Icon name="lock" size={18} /> Password protected</span><span><Icon name="shield" size={18} /> MFA secured</span></div></div>
      <div className="water-orb orb-one" /><div className="water-orb orb-two" /><p className="copyright">Living Water Mega Parish – RCCG</p>
    </section>
    <section className="login-panel-wrap"><div className="login-panel auth-panel">{children}{aside}</div></section>
  </main>;
}

function RecoveryCodes({ codes, onContinue }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  async function copyCodes() {
    try { await navigator.clipboard.writeText(codes.join('\n')); setCopied(true); } catch { setCopied(false); }
  }
  return <div className="recovery-codes"><div className="security-icon"><Icon name="shield" size={24} /></div><span className="eyebrow">One-time backup</span><h2>Save your recovery codes</h2><p>Keep these ten codes in a password manager or another safe offline place. Each code works once. They will not be shown again.</p><div className="recovery-grid">{codes.map((code) => <code key={code}>{code}</code>)}</div><Button type="button" variant="secondary" className="full-width" onClick={copyCodes} icon="download">{copied ? 'Copied to clipboard' : 'Copy recovery codes'}</Button><label className="check-row"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} /><span>I have saved these codes securely.</span></label><Button type="button" className="full-width" disabled={!saved} onClick={onContinue} icon="arrowRight">Continue to workspace</Button></div>;
}

function MfaSetupScreen({ context, onSignedIn, onCancel }) {
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [completedUser, setCompletedUser] = useState(null);

  async function startTotp() {
    setError(''); setWorking(true);
    try { const result = await api('/api/auth/mfa/totp/start', { method: 'POST' }); setEnrollment(result.enrollment); }
    catch (requestError) { setError(requestError.message); }
    finally { setWorking(false); }
  }
  async function confirmTotp(event) {
    event.preventDefault(); setError(''); setWorking(true);
    try { const result = await api('/api/auth/mfa/totp/confirm', { method: 'POST', body: { code } }); setCompletedUser(result.user); setRecoveryCodes(result.recoveryCodes); }
    catch (requestError) { setError(requestError.message); }
    finally { setWorking(false); }
  }
  async function addPasskey() {
    setError(''); setWorking(true);
    try {
      const optionsResult = await api('/api/auth/passkeys/registration/options', { method: 'POST' });
      const response = await startRegistration({ optionsJSON: optionsResult.options });
      const result = await api('/api/auth/passkeys/registration/verify', { method: 'POST', body: { response } });
      onSignedIn(result.user);
    } catch (requestError) { setError(requestError.message || 'Your passkey could not be enrolled.'); }
    finally { setWorking(false); }
  }
  if (recoveryCodes) return <AuthShell eyebrow="MFA enrolled" title="Your account is protected." body="Save the backup codes before moving into the private workspace."><RecoveryCodes codes={recoveryCodes} onContinue={() => onSignedIn(completedUser || context.user)} /></AuthShell>;
  return <AuthShell eyebrow="First-time security setup" title="Protect your staff account." body="Choose an authenticator app or a passkey. You need one secure method before accessing member-care data.">
    <div className="panel-heading"><span className="eyebrow">Welcome, {context.user?.fullName?.split(' ')[0] || 'staff member'}</span><h2>Set up MFA</h2><p>An authenticator app is recommended because it also provides recovery codes.</p></div>
    {!enrollment ? <div className="mfa-choice-stack"><button className="mfa-choice" type="button" onClick={startTotp} disabled={working}><span className="choice-icon"><Icon name="phone" size={21} /></span><span><strong>Authenticator app</strong><small>Use Google Authenticator, Microsoft Authenticator, Authy, or 1Password.</small></span><Icon name="chevronRight" size={18} /></button><button className="mfa-choice" type="button" onClick={addPasskey} disabled={working}><span className="choice-icon"><Icon name="lock" size={21} /></span><span><strong>Passkey</strong><small>Use your device screen lock, fingerprint, face, or security key.</small></span><Icon name="chevronRight" size={18} /></button></div> : <form className="login-form mfa-setup-form" onSubmit={confirmTotp}><div className="qr-wrap"><img src={enrollment.qrCodeDataUrl} alt="QR code for authenticator app setup" /><div><strong>Scan this QR code</strong><p>Open your authenticator app, add an account, then scan the code.</p><code className="manual-totp-key">{enrollment.manualKey}</code><small>Or enter this setup key manually. It expires shortly.</small></div></div><label>Six-digit code<input inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={6} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" required /></label><Button type="submit" className="full-width" loading={working} icon="check">Verify and enable MFA</Button></form>}
    {error && <div className="form-alert"><Icon name="alert" size={16} />{error}</div>}
    <button type="button" className="text-action" onClick={onCancel}>Return to sign in</button>
  </AuthShell>;
}

function MfaChallengeScreen({ context, onSignedIn, onCancel }) {
  const [method, setMethod] = useState('totp');
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  if (context.enrollmentRequired) return <MfaSetupScreen context={context} onSignedIn={onSignedIn} onCancel={onCancel} />;
  async function verifyCode(event) {
    event.preventDefault(); setError(''); setWorking(true);
    try { const result = await api('/api/auth/mfa/verify', { method: 'POST', body: { method, code } }); onSignedIn(result.user); }
    catch (requestError) { setError(requestError.message); }
    finally { setWorking(false); }
  }
  async function verifyPasskey() {
    setError(''); setWorking(true);
    try { const optionsResult = await api('/api/auth/mfa/passkey/options', { method: 'POST' }); const response = await startAuthentication({ optionsJSON: optionsResult.options }); const result = await api('/api/auth/mfa/passkey/verify', { method: 'POST', body: { response } }); onSignedIn(result.user); }
    catch (requestError) { setError(requestError.message || 'Your passkey could not be verified.'); }
    finally { setWorking(false); }
  }
  const showPasskey = context.methods?.passkey;
  const showTotp = context.methods?.totp;
  return <AuthShell eyebrow="Second step required" title="Verify it’s you." body="Your password was accepted. Complete MFA to continue to the protected member-care workspace.">
    <div className="panel-heading"><span className="eyebrow">{context.user?.email}</span><h2>{showTotp ? 'Enter your verification code' : 'Use your passkey'}</h2><p>Use the secure sign-in method you enrolled.</p></div>
    {showTotp && <form className="login-form" onSubmit={verifyCode}><label>{method === 'totp' ? 'Authenticator app code' : 'Recovery code'}<input inputMode={method === 'totp' ? 'numeric' : 'text'} autoComplete={method === 'totp' ? 'one-time-code' : 'off'} value={code} onChange={(event) => setCode(method === 'totp' ? event.target.value.replace(/\D/g, '') : event.target.value.toUpperCase())} placeholder={method === 'totp' ? '000000' : 'ABCDE-FGHIJ'} maxLength={method === 'totp' ? 6 : 20} required /></label>{error && <div className="form-alert"><Icon name="alert" size={16} />{error}</div>}<Button type="submit" className="full-width" loading={working} icon="shield">Verify and continue</Button></form>}
    {showPasskey && <div className="mfa-alternate">{!showTotp && error && <div className="form-alert"><Icon name="alert" size={16} />{error}</div>}<Button type="button" variant={showTotp ? 'secondary' : 'primary'} className="full-width" onClick={verifyPasskey} loading={working} icon="lock">{showTotp ? 'Use passkey instead' : 'Verify with passkey'}</Button></div>}
    {showTotp && <div className="mfa-alternate"><button type="button" className="text-action" onClick={() => { setMethod(method === 'totp' ? 'recovery' : 'totp'); setCode(''); setError(''); }}>{method === 'totp' ? 'Use a recovery code instead' : 'Use an authenticator app code instead'}</button></div>}<button type="button" className="text-action" onClick={onCancel}>Return to sign in</button>
  </AuthShell>;
}

function InvitationAcceptScreen({ token, onMfaRequired, onCancel }) {
  const [state, setState] = useState({ loading: true, invitation: null, error: '' });
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [working, setWorking] = useState(false);
  useEffect(() => { api(`/api/invitations/${encodeURIComponent(token)}`).then((result) => setState({ loading: false, invitation: result.invitation, error: '' })).catch((error) => setState({ loading: false, invitation: null, error: error.message })); }, [token]);
  async function accept(event) {
    event.preventDefault(); setState((current) => ({ ...current, error: '' }));
    if (password !== confirmPassword) { setState((current) => ({ ...current, error: 'The passwords do not match.' })); return; }
    setWorking(true);
    try { const result = await api(`/api/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', body: { password } }); onMfaRequired(result); }
    catch (error) { setState((current) => ({ ...current, error: error.message })); }
    finally { setWorking(false); }
  }
  return <AuthShell eyebrow="Staff invitation" title="Join the care team." body="Create a protected staff account, then enrol MFA before accessing member information.">
    {state.loading ? <LoadingBlock rows={4} /> : state.invitation ? <><div className="invite-summary"><Avatar name={state.invitation.fullName} /><div><span className="eyebrow">Invited role</span><h2>{state.invitation.fullName}</h2><p>{statusLabel(state.invitation.role)} · {state.invitation.emailMasked}</p></div></div><form className="login-form" onSubmit={accept}><label>Create password<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /></label><label>Confirm password<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} required /></label><small className="field-help">At least 12 characters, including upper-case, lower-case, and a number.</small>{state.error && <div className="form-alert"><Icon name="alert" size={16} />{state.error}</div>}<Button type="submit" className="full-width" loading={working} icon="arrowRight">Create account and set up MFA</Button></form></> : <EmptyState icon="alert" title="Invitation unavailable" body={state.error || 'This invitation is not valid.'} action={<Button variant="secondary" onClick={onCancel}>Go to sign in</Button>} />}
  </AuthShell>;
}

function Navigation({ page, setPage, user, onLogout }) {
  const items = [
    { id: 'overview', label: 'Overview', icon: 'grid', visible: true },
    { id: 'members', label: 'Members', icon: 'people', visible: ['owner', 'membership_officer'].includes(user.role) },
    { id: 'birthdays', label: 'Birthdays', icon: 'calendar', visible: ['owner', 'membership_officer', 'birthday_coordinator'].includes(user.role) },
    { id: 'deliveries', label: 'Deliveries', icon: 'send', visible: true },
    { id: 'settings', label: 'Settings', icon: 'settings', visible: true },
    { id: 'staff', label: 'Staff access', icon: 'people', visible: user.role === 'owner' },
    { id: 'audit', label: 'Audit log', icon: 'shield', visible: ['owner', 'auditor'].includes(user.role) },
  ].filter((item) => item.visible);
  return <aside className="sidebar">
    <div className="sidebar-brand"><span className="brand-mark"><Icon name="droplet" size={22} /></span><span><strong>Living Water</strong><small>Birthday Care</small></span></div>
    <nav aria-label="Main navigation">{items.map((item) => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}><Icon name={item.icon} size={19} /><span>{item.label}</span>{item.id === 'deliveries' && <span className="nav-dot" />}</button>)}</nav>
    <div className="sidebar-footer"><div className="secure-lock"><Icon name="lock" size={15} /><span>Private workspace</span></div><div className="user-card"><Avatar name={user.fullName} small /><span><strong>{user.fullName}</strong><small>{user.role.replace(/_/g, ' ')}</small></span><button onClick={onLogout} aria-label="Sign out" title="Sign out"><Icon name="logout" size={17} /></button></div></div>
  </aside>;
}

function MobileNavigation({ page, setPage, user }) {
  const items = [
    { id: 'overview', label: 'Home', icon: 'grid', visible: true },
    { id: 'members', label: 'Members', icon: 'people', visible: ['owner', 'membership_officer'].includes(user.role) },
    { id: 'birthdays', label: 'Birthdays', icon: 'calendar', visible: ['owner', 'membership_officer', 'birthday_coordinator'].includes(user.role) },
    { id: 'deliveries', label: 'Alerts', icon: 'send', visible: true },
    { id: 'settings', label: 'Settings', icon: 'settings', visible: true },
    { id: 'staff', label: 'Staff', icon: 'people', visible: user.role === 'owner' },
  ].filter((item) => item.visible);
  return <nav className="mobile-nav" aria-label="Mobile navigation">{items.map((item) => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}><Icon name={item.icon} size={19} /><span>{item.label}</span></button>)}</nav>;
}

function Header({ page, user, onAddMember, onRunDaily, running, setPage }) {
  const titleMap = { overview: ['Good morning', 'Here is your birthday-care overview.'], members: ['People directory', 'Keep the birthday list clean, current and protected.'], birthdays: ['Birthday calendar', 'Plan intentional care for every celebration.'], deliveries: ['Delivery centre', 'Track notification outcomes across your approved channels.'], settings: ['Notification settings', 'Keep preferences, channels and delivery rules under control.'], staff: ['Staff access', 'Invite the care team and keep each person’s access protected.'], audit: ['Audit trail', 'A transparent record of important workspace actions.'] };
  const [title, subtitle] = titleMap[page] || titleMap.overview;
  const canAdd = ['owner', 'membership_officer'].includes(user.role);
  return <header className="page-header"><div><span className="eyebrow">Living Water Mega Parish – RCCG</span><h1>{title}</h1><p>{subtitle}</p></div><div className="header-actions">
    {page === 'overview' && user.role === 'owner' && <Button variant="soft" icon="refresh" onClick={onRunDaily} loading={running}>Run daily check</Button>}
    {canAdd && <Button icon="plus" onClick={onAddMember}>Add member</Button>}
    {page !== 'overview' && <button className="header-bell" onClick={() => setPage('deliveries')} aria-label="Open deliveries"><Icon name="bell" size={19} /><span /></button>}
  </div></header>;
}

function StatCard({ label, value, note, icon, tone = 'aqua', action = null }) {
  return <article className={`stat-card stat-${tone}`}><div className="stat-top"><span className="stat-icon"><Icon name={icon} size={20} /></span>{action}</div><strong className="stat-value">{value}</strong><span className="stat-label">{label}</span><small>{note}</small></article>;
}

function BirthdayRow({ item, compact = false }) {
  return <div className={`birthday-row ${compact ? 'compact' : ''}`}><Avatar name={item.fullName} small /><div className="birthday-person"><strong>{item.preferredName || item.firstName} {item.lastName}</strong><span>{item.ministryGroup} · {item.memberCode}</span></div><div className="birthday-when"><strong>{dateLabel(item)}</strong><span>{formatDate(item.occurrenceDate, { day: 'numeric', month: 'short' })}</span></div></div>;
}

function ChannelPill({ channel }) {
  return <span className={`channel-pill channel-${channel}`}><Icon name={channel === 'whatsapp' ? 'whatsapp' : 'phone'} size={14} />{channelLabel(channel)}</span>;
}

function NotificationStatus({ notification }) {
  return <div className="notification-status"><ChannelPill channel={notification.channel} /><Badge tone={statusTone(notification.status)}>{statusLabel(notification.status)}</Badge></div>;
}

function OverviewPage({ user, refreshKey, setPage, onAddMember, onRunDaily, running }) {
  const { loading, error, data } = useRemoteData('/api/dashboard', refreshKey);
  if (loading) return <div className="content-grid"><LoadingBlock rows={7} /></div>;
  if (error) return <ErrorPanel error={error} />;
  const delivery = data.stats.deliveryRate === null ? '—' : `${data.stats.deliveryRate}%`;
  return <div className="overview-content">
    <section className="overview-hero">
      <div className="hero-copy"><Badge tone="aqua" icon="calendar">{formatDate(data.date, { weekday: 'long' })}</Badge><h2>Small moments. <span>Lasting care.</span></h2><p>Today’s list is ready, protected by role-based access and a reliable delivery trail.</p><div className="hero-actions"><Button icon="calendar" onClick={() => setPage('birthdays')}>View birthday calendar</Button>{['owner', 'membership_officer'].includes(user.role) && <Button variant="ghost-light" icon="plus" onClick={onAddMember}>Add a member</Button>}</div></div>
      <div className="hero-wave"><div className="wave-card"><span className="wave-icon"><Icon name="bell" size={22} /></span><span><small>Today’s care list</small><strong>{data.stats.todaysBirthdays} birthday{data.stats.todaysBirthdays === 1 ? '' : 's'}</strong></span><span className="pulse-dot" /></div><div className="hero-rings"><span /><span /><span /></div></div>
    </section>
    <section className="stats-grid">
      <StatCard label="Today’s birthdays" value={data.stats.todaysBirthdays} note="Active, authorised records" icon="calendar" tone="aqua" />
      <StatCard label="Next 7 days" value={data.stats.nextSevenDays} note="Plan thoughtful follow-up" icon="clock" tone="blue" action={<button className="mini-link" onClick={() => setPage('birthdays')}>View <Icon name="arrowRight" size={14} /></button>} />
      <StatCard label="Delivery health" value={delivery} note={data.stats.failedDeliveries ? `${data.stats.failedDeliveries} alert(s) need review` : 'Last 30 days'} icon="send" tone={data.stats.failedDeliveries ? 'amber' : 'green'} action={<span className={`health-dot ${data.stats.failedDeliveries ? 'warning' : ''}`} />} />
      <StatCard label="Data quality" value={data.stats.dataHealthIssues || 'Good'} note={data.stats.dataHealthIssues ? 'Records need attention' : 'No urgent record issues'} icon="shield" tone={data.stats.dataHealthIssues ? 'amber' : 'purple'} />
    </section>
    <section className="dashboard-columns">
      <article className="surface-card today-card"><div className="card-heading"><div><span className="eyebrow">Today</span><h2>Birthday care list</h2></div><button className="text-link" onClick={() => setPage('birthdays')}>See all <Icon name="arrowRight" size={15} /></button></div>
        {data.todaysBirthdays.length ? <div className="birthday-list">{data.todaysBirthdays.map((item) => <BirthdayRow item={item} key={item.id} />)}</div> : <EmptyState icon="calendar" title="No birthdays due today" body="The next celebration will appear here when it is due." />}
        {data.todaysBirthdays.length > 0 && <div className="care-tip"><span><Icon name="info" size={16} /></span><p><strong>Care tip</strong> Keep the greeting personal. The dashboard protects contact details until a role explicitly needs them.</p></div>}
      </article>
      <article className="surface-card delivery-card"><div className="card-heading"><div><span className="eyebrow">Operations</span><h2>Recent delivery activity</h2></div><button className="text-link" onClick={() => setPage('deliveries')}>Open centre <Icon name="arrowRight" size={15} /></button></div>
        {data.recentNotifications.length ? <div className="activity-list">{data.recentNotifications.map((notification) => <div className="activity-item" key={notification.id}><span className={`activity-icon ${notification.channel}`}><Icon name={notification.channel === 'whatsapp' ? 'whatsapp' : 'phone'} size={17} /></span><div><strong>{notification.memberCount ? `${notification.memberCount} birthday${notification.memberCount === 1 ? '' : 's'} due` : 'Delivery test'}</strong><span>{notification.recipientName} · {humanTime(notification.createdAt)}</span></div><Badge tone={statusTone(notification.status)}>{statusLabel(notification.status)}</Badge></div>)}</div> : <EmptyState icon="send" title="No deliveries yet" body="Once the first reminder is processed, its delivery record will appear here." />}
        {user.role === 'owner' && <button className="run-rule-button" onClick={onRunDaily} disabled={running}><Icon name="refresh" size={17} />{running ? 'Checking birthdays…' : 'Run today’s rule now'}<Icon name="arrowRight" size={17} /></button>}
      </article>
    </section>
    <section className="surface-card upcoming-strip"><div className="card-heading"><div><span className="eyebrow">Coming up</span><h2>Next celebrations</h2></div><button className="text-link" onClick={() => setPage('birthdays')}>Full calendar <Icon name="arrowRight" size={15} /></button></div>
      <div className="upcoming-grid">{data.upcoming.slice(0, 5).map((item) => <article className="upcoming-card" key={item.id}><span className="upcoming-day">{formatDate(item.occurrenceDate, { day: 'numeric' })}</span><span className="upcoming-month">{formatDate(item.occurrenceDate, { month: 'short' })}</span><Avatar name={item.fullName} small /><strong>{item.preferredName || item.firstName} {item.lastName}</strong><small>{item.ministryGroup}</small></article>)}</div>
    </section>
  </div>;
}

function ErrorPanel({ error, title = 'Unable to load this workspace area' }) {
  return <div className="surface-card error-panel"><span className="error-icon"><Icon name="alert" size={23} /></span><div><h2>{title}</h2><p>{error.message}</p></div></div>;
}

function MemberFormModal({ member = null, onClose, onSaved, showToast }) {
  const [form, setForm] = useState(() => ({
    firstName: member?.firstName || '', lastName: member?.lastName || '', preferredName: member?.preferredName || '', phone: member?.phone || '',
    birthMonth: member?.birthMonth || '', birthDay: member?.birthDay || '', birthYear: member?.birthYear || '', status: member?.status || 'active',
    ministryGroup: member?.ministryGroup || 'General', birthdayAlertAllowed: member?.birthdayAlertAllowed ?? true, consentRecorded: Boolean(member), confirmPotentialDuplicate: false,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState(null);

  const months = Array.from({ length: 12 }).map((_, index) => ({ value: index + 1, label: new Intl.DateTimeFormat('en-NG', { month: 'long' }).format(new Date(2024, index, 1)) }));
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  async function save(event, forceDuplicate = false) {
    event?.preventDefault();
    setSaving(true); setError('');
    try {
      const payload = { ...form, birthMonth: Number(form.birthMonth), birthDay: Number(form.birthDay), birthYear: form.birthYear ? Number(form.birthYear) : null, confirmPotentialDuplicate: forceDuplicate || form.confirmPotentialDuplicate };
      const response = await api(member ? `/api/members/${member.id}` : '/api/members', { method: member ? 'PATCH' : 'POST', body: payload });
      showToast(response.message, 'success');
      onSaved(response.member);
      onClose();
    } catch (requestError) {
      if (requestError.code === 'DUPLICATE_CANDIDATE') {
        setDuplicate(requestError.details?.existing || null);
        setError(requestError.message);
      } else {
        setError(requestError.message);
      }
    } finally { setSaving(false); }
  }
  return <Modal title={member ? 'Edit member record' : 'Add a member'} subtitle={member ? `Update ${member.memberCode}. Changes are recorded in the audit trail.` : 'Only collect what is needed for birthday care and authorised membership administration.'} onClose={onClose} wide>
    <form className="member-form" onSubmit={save}>
      <div className="form-section"><span className="form-section-title">Member identity</span><div className="form-grid two"><label>First name<input value={form.firstName} onChange={(event) => update('firstName', event.target.value)} required /></label><label>Last name<input value={form.lastName} onChange={(event) => update('lastName', event.target.value)} required /></label><label>Preferred name <span className="optional">optional</span><input value={form.preferredName} onChange={(event) => update('preferredName', event.target.value)} /></label><label>Ministry group<input value={form.ministryGroup} onChange={(event) => update('ministryGroup', event.target.value)} required placeholder="e.g. Welcome" /></label></div></div>
      <div className="form-section"><span className="form-section-title">Birthday and contact</span><div className="form-grid birthday-grid"><label className="span-two">Mobile number<input value={form.phone} onChange={(event) => update('phone', event.target.value)} inputMode="tel" required placeholder="0803 000 0000" /><small>Accepted as Nigerian local format or international E.164 format.</small></label><label>Birthday month<select value={form.birthMonth} onChange={(event) => update('birthMonth', event.target.value)} required><option value="">Select month</option>{months.map((month) => <option key={month.value} value={month.value}>{month.label}</option>)}</select></label><label>Day<input type="number" min="1" max="31" value={form.birthDay} onChange={(event) => update('birthDay', event.target.value)} required placeholder="14" /></label><label>Birth year <span className="optional">optional</span><input type="number" min="1900" max={new Date().getFullYear()} value={form.birthYear} onChange={(event) => update('birthYear', event.target.value)} placeholder="1990" /><small>Do not collect when not needed.</small></label></div></div>
      <div className="form-section"><span className="form-section-title">Care settings</span><div className="form-grid two"><label>Membership status<select value={form.status} onChange={(event) => update('status', event.target.value)}><option value="active">Active</option><option value="visitor">Visitor</option><option value="inactive">Inactive</option><option value="archived">Archived</option><option value="deceased">Deceased</option></select></label><label className="switch-field"><span>Birthday reminders</span><button type="button" role="switch" aria-checked={form.birthdayAlertAllowed} className={`switch ${form.birthdayAlertAllowed ? 'on' : ''}`} onClick={() => update('birthdayAlertAllowed', !form.birthdayAlertAllowed)}><span /></button><small>{form.birthdayAlertAllowed ? 'Eligible for authorised birthday-care alerts.' : 'Suppressed from future alerts.'}</small></label></div></div>
      {!member && <label className="consent-box"><input type="checkbox" checked={form.consentRecorded} onChange={(event) => update('consentRecorded', event.target.checked)} /><span><strong>Membership/privacy record confirmed</strong><small>I have recorded the parish’s applicable collection basis and presented the current privacy notice where required.</small></span></label>}
      {error && <div className="form-alert"><Icon name="alert" size={17} /><span>{error}{duplicate && <><br /><button type="button" className="inline-action" onClick={(event) => save(event, true)}>Save as a separate record anyway</button></>}</span></div>}
      <footer className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={saving} icon="check">{member ? 'Save changes' : 'Save member'}</Button></footer>
    </form>
  </Modal>;
}

function ImportModal({ onClose, onImported, showToast }) {
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState('');
  const template = 'first_name,last_name,phone,birthday,ministry_group\nAda,Okafor,08031111001,14/09/1992,Welcome\n';
  async function loadFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 450000) { setError('Choose a CSV file under 450 KB.'); return; }
    setCsvText(await file.text()); setPreview(null); setError('');
  }
  async function previewRows() {
    setLoading(true); setError('');
    try { setPreview(await api('/api/imports/preview', { method: 'POST', body: { csvText } })); } catch (requestError) { setError(requestError.message); } finally { setLoading(false); }
  }
  async function commit() {
    if (!preview?.summary.ready) return;
    setCommitting(true); setError('');
    try {
      const result = await api('/api/imports/commit', { method: 'POST', body: { rows: preview.rows.filter((row) => row.valid && !row.duplicate) } });
      showToast(result.message, 'success'); onImported(); onClose();
    } catch (requestError) { setError(requestError.message); } finally { setCommitting(false); }
  }
  return <Modal title="Import member records" subtitle="Preview every row before it is committed. The server does not retain the raw CSV file." onClose={onClose} wide>
    <div className="import-modal"><div className="import-steps"><span className="active"><b>1</b>Choose CSV</span><i /><span className={preview ? 'active' : ''}><b>2</b>Review</span><i /><span><b>3</b>Commit</span></div>
      {!preview ? <><div className="upload-zone"><Icon name="upload" size={27} /><strong>Choose a CSV member file</strong><p>Required columns: first name, last name, phone, birthday and ministry group.</p><input type="file" accept=".csv,text/csv" onChange={loadFile} /><small>Maximum 500 rows · 450 KB · raw file is not retained</small></div><div className="template-row"><span>Need a starting format?</span><button onClick={() => { setCsvText(template); setError(''); }}>Use sample CSV</button><button onClick={() => { const blob = new Blob([template], { type: 'text/csv' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'living-water-member-import-template.csv'; link.click(); URL.revokeObjectURL(url); }}><Icon name="download" size={15} />Download template</button></div>{csvText && <div className="csv-ready"><Icon name="file" size={18} /><span>CSV is ready for review ({csvText.split('\n').filter(Boolean).length - 1} data row(s))</span><Button onClick={previewRows} loading={loading} icon="eye">Preview rows</Button></div>}</> : <><div className="import-summary"><span className="summary-total"><strong>{preview.summary.total}</strong><small>Rows read</small></span><span className="summary-good"><strong>{preview.summary.ready}</strong><small>Ready to import</small></span><span className="summary-warn"><strong>{preview.summary.invalid}</strong><small>Need correction</small></span><span className="summary-duplicate"><strong>{preview.summary.duplicates}</strong><small>Possible duplicates</small></span></div><div className="import-preview-table"><table><thead><tr><th>Row</th><th>Member</th><th>Birthday</th><th>Group</th><th>Review</th></tr></thead><tbody>{preview.rows.slice(0, 12).map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td><strong>{row.firstName} {row.lastName}</strong><small>{row.phone || 'No valid phone'}</small></td><td>{row.birthDay && row.birthMonth ? `${row.birthDay}/${row.birthMonth}${row.birthYear ? `/${row.birthYear}` : ''}` : '—'}</td><td>{row.ministryGroup}</td><td>{row.valid && !row.duplicate ? <Badge tone="success" icon="check">Ready</Badge> : row.duplicate ? <Badge tone="warning">Possible duplicate</Badge> : <Badge tone="danger">{row.errors[0] || 'Invalid'}</Badge>}</td></tr>)}</tbody></table>{preview.rows.length > 12 && <p className="more-rows">Showing 12 of {preview.rows.length} reviewed rows.</p>}</div><div className="privacy-callout"><Icon name="shield" size={18} /><p>Only rows marked ready will be imported. Potential duplicates and invalid rows stay out until they are reviewed.</p></div></>}
      {error && <div className="form-alert"><Icon name="alert" size={17} />{error}</div>}
      <footer className="modal-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button>{preview ? <Button onClick={commit} loading={committing} disabled={!preview.summary.ready} icon="check">Import {preview.summary.ready} ready record{preview.summary.ready === 1 ? '' : 's'}</Button> : <Button onClick={previewRows} disabled={!csvText} loading={loading} icon="eye">Preview rows</Button>}</footer>
    </div>
  </Modal>;
}

function MembersPage({ user, refreshKey, onRefresh, showToast, onAddMember }) {
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [group, setGroup] = useState('all');
  const [editing, setEditing] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const url = `/api/members?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}&group=${encodeURIComponent(group)}`;
  const { loading, error, data } = useRemoteData(url, refreshKey);
  function submitSearch(event) { event.preventDefault(); setSearch(searchText); }
  return <div className="page-content"><section className="toolbar"><form className="search-field" onSubmit={submitSearch}><Icon name="search" size={18} /><input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search name or member code" /><button aria-label="Search" type="submit"><Icon name="arrowRight" size={17} /></button></form><div className="toolbar-actions"><select aria-label="Membership status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="visitor">Visitor</option><option value="inactive">Inactive</option><option value="archived">Archived</option><option value="deceased">Deceased</option></select><select aria-label="Ministry group" value={group} onChange={(event) => setGroup(event.target.value)}><option value="all">All groups</option>{data?.groups?.map((name) => <option value={name} key={name}>{name}</option>)}</select><Button variant="secondary" icon="upload" onClick={() => setShowImport(true)}>Import</Button><Button icon="plus" onClick={onAddMember}>Add member</Button></div></section>
    <section className="surface-card table-card"><div className="table-card-head"><div><h2>Member records</h2><p>{data ? `${data.total} protected record${data.total === 1 ? '' : 's'}` : 'Loading records…'}</p></div><Badge tone="aqua" icon="shield">Phone fields protected</Badge></div>{loading ? <LoadingBlock rows={8} /> : error ? <ErrorPanel error={error} /> : data.items.length ? <div className="responsive-table"><table className="member-table"><thead><tr><th>Member</th><th>Birthday</th><th>Group</th><th>Status</th><th>Phone</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{data.items.map((member) => <tr key={member.id}><td><div className="member-cell"><Avatar name={member.fullName} small /><span><strong>{member.preferredName || member.firstName} {member.lastName}</strong><small>{member.memberCode}</small></span></div></td><td><strong>{new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short' }).format(new Date(2024, member.birthMonth - 1, member.birthDay))}</strong>{member.birthYear && <small className="sub-detail">Year restricted</small>}</td><td><Badge tone="neutral">{member.ministryGroup}</Badge></td><td><Badge tone={member.status === 'active' ? 'success' : member.status === 'archived' ? 'neutral' : 'warning'}>{statusLabel(member.status)}</Badge></td><td><span className="phone-cell"><Icon name="lock" size={13} />{member.phone}</span></td><td><button className="row-action" onClick={() => setEditing(member)} aria-label={`Edit ${member.fullName}`}><Icon name="dots" size={20} /></button></td></tr>)}</tbody></table></div> : <EmptyState icon="people" title="No matching members" body="Adjust the filters or add a member to begin." action={<Button icon="plus" onClick={onAddMember}>Add member</Button>} />}</section>
    <section className="directory-footer"><Icon name="shield" size={18} /><p><strong>Privacy by default.</strong> Member contact data is shown only to roles that need it for approved membership care. Every change is recorded.</p></section>
    {editing && <MemberFormModal member={editing} onClose={() => setEditing(null)} onSaved={onRefresh} showToast={showToast} />}
    {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={onRefresh} showToast={showToast} />}
  </div>;
}

function BirthdaysPage({ refreshKey }) {
  const [days, setDays] = useState(30);
  const { loading, error, data } = useRemoteData(`/api/birthdays/upcoming?days=${days}`, refreshKey);
  const grouped = useMemo(() => {
    const groups = new Map();
    data?.items?.forEach((item) => { const existing = groups.get(item.occurrenceDate) || []; existing.push(item); groups.set(item.occurrenceDate, existing); });
    return [...groups.entries()];
  }, [data]);
  return <div className="page-content"><section className="birthday-banner"><div><Badge tone="aqua" icon="calendar">Africa/Lagos timezone</Badge><h2>Plan meaningful birthday care</h2><p>Only records within your assigned permissions appear here. Birth years and phone numbers remain hidden by default.</p></div><div className="range-tabs" role="group" aria-label="Birthday calendar range">{[14, 30, 60].map((value) => <button key={value} className={days === value ? 'active' : ''} onClick={() => setDays(value)}>Next {value} days</button>)}</div></section>
    {loading ? <LoadingBlock rows={10} /> : error ? <ErrorPanel error={error} /> : grouped.length ? <section className="birthday-timeline">{grouped.map(([date, items]) => <div className="timeline-group" key={date}><div className="timeline-date"><span>{formatDate(date, { weekday: 'short' })}</span><strong>{formatDate(date, { day: 'numeric', month: 'long' })}</strong><small>{items.length} birthday{items.length === 1 ? '' : 's'}</small></div><div className="timeline-line" /> <div className="timeline-items">{items.map((item) => <article className="timeline-person" key={item.id}><Avatar name={item.fullName} /><div><h3>{item.preferredName || item.firstName} {item.lastName}</h3><p>{item.memberCode} · {item.ministryGroup}</p></div><Badge tone={item.daysUntil === 0 ? 'aqua' : 'neutral'}>{dateLabel(item)}</Badge></article>)}</div></div>)}</section> : <EmptyState icon="calendar" title="No birthdays in this period" body="Check data-quality records or choose a wider date range." />}
  </div>;
}

function DeliveriesPage({ user, refreshKey, onRefresh, showToast }) {
  const { loading, error, data } = useRemoteData('/api/notifications?limit=60', refreshKey);
  const [testing, setTesting] = useState(false);
  const [filter, setFilter] = useState('all');
  const filtered = useMemo(() => (data?.items || []).filter((item) => filter === 'all' || item.status === filter), [data, filter]);
  const totals = useMemo(() => ({ delivered: (data?.items || []).filter((item) => ['delivered', 'read'].includes(item.status)).length, failed: (data?.items || []).filter((item) => ['failed', 'dead_letter'].includes(item.status)).length, pending: (data?.items || []).filter((item) => ['queued', 'scheduled', 'retrying', 'provider_accepted', 'sent'].includes(item.status)).length }), [data]);
  async function sendTest() { setTesting(true); try { const result = await api('/api/notifications/test', { method: 'POST' }); showToast(result.message, 'success'); onRefresh(); } catch (requestError) { showToast(requestError.message, 'danger'); } finally { setTesting(false); } }
  return <div className="page-content"><section className="delivery-hero"><div><Badge tone="aqua" icon="send">Delivery record</Badge><h2>Every alert has a trail.</h2><p>Provider acceptance is not the same as delivery. This centre tracks the result and highlights any alert that needs attention.</p></div>{['owner', 'membership_officer', 'birthday_coordinator'].includes(user.role) && <Button icon="send" onClick={sendTest} loading={testing}>Send safe test alert</Button>}</section>
    <section className="delivery-stats"><div><Icon name="check" size={19} /><strong>{totals.delivered}</strong><span>Delivered/read</span></div><div><Icon name="clock" size={19} /><strong>{totals.pending}</strong><span>Pending</span></div><div className={totals.failed ? 'has-alert' : ''}><Icon name="alert" size={19} /><strong>{totals.failed}</strong><span>Needs review</span></div></section>
    <section className="surface-card table-card"><div className="table-card-head"><div><h2>{user.role === 'owner' ? 'Parish deliveries' : 'My alert deliveries'}</h2><p>Mock provider mode is clearly marked in this demonstration.</p></div><div className="filter-tabs">{['all', 'delivered', 'failed', 'provider_accepted'].map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : statusLabel(value)}</button>)}</div></div>{loading ? <LoadingBlock rows={6} /> : error ? <ErrorPanel error={error} /> : filtered.length ? <div className="responsive-table"><table className="delivery-table"><thead><tr><th>Alert</th><th>Recipient</th><th>Channel</th><th>Outcome</th><th>When</th><th>Provider</th></tr></thead><tbody>{filtered.map((notification) => <tr key={notification.id}><td><strong>{notification.type === 'test' ? 'Safe delivery test' : `${notification.memberCount} birthday${notification.memberCount === 1 ? '' : 's'} due`}</strong><small>{notification.messagePreview}</small></td><td><div className="recipient-cell"><Avatar name={notification.recipientName} small /><span>{notification.recipientName}<small>{notification.endpointLabel}</small></span></div></td><td><ChannelPill channel={notification.channel} /></td><td><Badge tone={statusTone(notification.status)}>{statusLabel(notification.status)}</Badge>{notification.errorMessage && <small className="error-detail">{notification.errorMessage}</small>}</td><td><strong>{formatDate(notification.createdAt, { day: 'numeric', month: 'short' })}</strong><small>{formatTime(notification.createdAt)}</small></td><td><Badge tone={notification.provider === 'mock' ? 'warning' : 'neutral'}>{notification.provider || 'queued'}</Badge></td></tr>)}</tbody></table></div> : <EmptyState icon="send" title="No matching deliveries" body="Try a different outcome filter or send a safe test alert." />}</section>
  </div>;
}

function EndpointVerificationModal({ endpoint, initialVerification = null, onClose, onVerified, showToast }) {
  const [verification, setVerification] = useState(initialVerification);
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function confirm(event) {
    event.preventDefault(); setError(''); setWorking(true);
    try {
      const result = await api(`/api/endpoints/${endpoint.id}/verification/confirm`, { method: 'POST', body: { code } });
      showToast(result.message, 'success'); onVerified?.(result.endpoint); onClose();
    } catch (requestError) { setError(requestError.message); }
    finally { setWorking(false); }
  }
  async function resend() {
    setError(''); setWorking(true);
    try { const result = await api(`/api/endpoints/${endpoint.id}/verification/resend`, { method: 'POST' }); setVerification(result.verification); showToast(result.message, 'success'); }
    catch (requestError) { setError(requestError.message); }
    finally { setWorking(false); }
  }
  return <Modal title="Verify alert endpoint" subtitle={`We sent a six-digit SMS ownership code to ${endpoint.phone}. This proof is required before ${channelLabel(endpoint.channel)} alerts can be enabled.`} onClose={onClose}>
    <form className="member-form verification-form" onSubmit={confirm}>
      {verification?.debugCode && <div className="demo-verification"><Icon name="info" size={17} /><span><strong>Mock delivery code</strong><br />Use <code>{verification.debugCode}</code> to complete the safe local demonstration. Real deployments never reveal this code in the dashboard.</span></div>}
      <label>SMS verification code<input inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={6} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" required autoFocus /></label>
      {error && <div className="form-alert"><Icon name="alert" size={17} />{error}</div>}
      <p className="field-help">The code expires in ten minutes. Up to five attempts are allowed per code.</p>
      <footer className="modal-actions"><Button type="button" variant="secondary" onClick={resend} loading={working}>Send a new code</Button><Button type="submit" loading={working} icon="check">Verify endpoint</Button></footer>
    </form>
  </Modal>;
}

function AddEndpointModal({ onClose, onAdded, showToast }) {
  const [form, setForm] = useState({ channel: 'whatsapp', phone: '', label: '', priority: 1, optInConfirmed: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  async function save(event) {
    event.preventDefault(); setSaving(true); setError('');
    try { const result = await api('/api/endpoints', { method: 'POST', body: form }); setCreated(result); onAdded(); }
    catch (requestError) { setError(requestError.message); }
    finally { setSaving(false); }
  }
  if (created) return <EndpointVerificationModal endpoint={created.endpoint} initialVerification={created.verification} showToast={showToast} onClose={onClose} onVerified={onAdded} />;
  return <Modal title="Add alert endpoint" subtitle="Record explicit alert consent, then verify the person controls this number by entering a code sent through SMS." onClose={onClose}>
    <form className="member-form" onSubmit={save}><div className="form-grid"><label>Alert channel<select value={form.channel} onChange={(event) => setForm((state) => ({ ...state, channel: event.target.value }))}><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select></label><label>Phone number<input value={form.phone} required placeholder="0803 000 0000" onChange={(event) => setForm((state) => ({ ...state, phone: event.target.value }))} /></label><label>Friendly label<input value={form.label} required placeholder="e.g. Ruth — WhatsApp" onChange={(event) => setForm((state) => ({ ...state, label: event.target.value }))} /></label><label>Priority<select value={form.priority} onChange={(event) => setForm((state) => ({ ...state, priority: Number(event.target.value) }))}><option value="1">1 — First choice</option><option value="2">2 — Fallback</option><option value="3">3 — Last resort</option></select></label></div><label className="check-row consent-check"><input type="checkbox" checked={form.optInConfirmed} onChange={(event) => setForm((state) => ({ ...state, optInConfirmed: event.target.checked }))} required /><span>I confirm that the staff member has expressly opted in to receive operational birthday alerts through this {channelLabel(form.channel)} number.</span></label>{error && <div className="form-alert"><Icon name="alert" size={17} />{error}</div>}<footer className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={saving} icon="arrowRight">Send verification code</Button></footer></form>
  </Modal>;
}

function SecuritySetupModal({ onClose, onComplete, showToast }) {
  const [status, setStatus] = useState(null);
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/auth/mfa/status').then(setStatus).catch((requestError) => setError(requestError.message)); }, []);
  async function startTotp() { setError(''); setWorking(true); try { const result = await api('/api/auth/mfa/totp/start', { method: 'POST' }); setEnrollment(result.enrollment); } catch (requestError) { setError(requestError.message); } finally { setWorking(false); } }
  async function verifyTotp(event) { event.preventDefault(); setError(''); setWorking(true); try { const result = await api('/api/auth/mfa/totp/confirm', { method: 'POST', body: { code } }); setRecoveryCodes(result.recoveryCodes); onComplete?.(result.user); } catch (requestError) { setError(requestError.message); } finally { setWorking(false); } }
  async function addPasskey() { setError(''); setWorking(true); try { const optionsResult = await api('/api/auth/passkeys/registration/options', { method: 'POST' }); const response = await startRegistration({ optionsJSON: optionsResult.options }); const result = await api('/api/auth/passkeys/registration/verify', { method: 'POST', body: { response } }); onComplete?.(result.user); showToast('Passkey enrolled successfully.', 'success'); onClose(); } catch (requestError) { setError(requestError.message || 'Your passkey could not be enrolled.'); } finally { setWorking(false); } }
  if (recoveryCodes) return <Modal title="Save recovery codes" subtitle="These backup codes are shown once. Store them securely before closing this dialog." onClose={onClose}><RecoveryCodes codes={recoveryCodes} onContinue={() => { showToast('MFA is now active on your account.', 'success'); onClose(); }} /></Modal>;
  return <Modal title="Account security" subtitle="Protect your staff account with an authenticator app or a passkey. At least one method is recommended for every staff member." onClose={onClose}>
    {!enrollment ? <div className="mfa-choice-stack"><button className="mfa-choice" type="button" onClick={startTotp} disabled={working}><span className="choice-icon"><Icon name="phone" size={21} /></span><span><strong>{status?.totpEnrolled ? 'Add another authenticator app' : 'Authenticator app'}</strong><small>Use Google Authenticator, Microsoft Authenticator, Authy, or 1Password. Includes recovery codes.</small></span><Icon name="chevronRight" size={18} /></button><button className="mfa-choice" type="button" onClick={addPasskey} disabled={working}><span className="choice-icon"><Icon name="lock" size={21} /></span><span><strong>{status?.passkeyEnrolled ? 'Add another passkey' : 'Passkey'}</strong><small>Use your device screen lock, fingerprint, face, or security key.</small></span><Icon name="chevronRight" size={18} /></button></div> : <form className="login-form mfa-setup-form" onSubmit={verifyTotp}><div className="qr-wrap"><img src={enrollment.qrCodeDataUrl} alt="QR code for authenticator app setup" /><div><strong>Scan this QR code</strong><p>Open your authenticator app, add an account, then scan the code.</p><code className="manual-totp-key">{enrollment.manualKey}</code><small>Or enter this setup key manually. It expires shortly.</small></div></div><label>Six-digit code<input inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={6} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" required /></label><Button type="submit" className="full-width" loading={working} icon="check">Verify and enable MFA</Button></form>}
    {error && <div className="form-alert"><Icon name="alert" size={16} />{error}</div>}
  </Modal>;
}

function RecoveryCodeRegenerateModal({ onClose, showToast }) {
  const [code, setCode] = useState(''); const [result, setResult] = useState(null); const [error, setError] = useState(''); const [working, setWorking] = useState(false);
  async function regenerate(event) { event.preventDefault(); setError(''); setWorking(true); try { const response = await api('/api/auth/mfa/recovery-codes', { method: 'POST', body: { code } }); setResult(response.recoveryCodes); } catch (requestError) { setError(requestError.message); } finally { setWorking(false); } }
  if (result) return <Modal title="New recovery codes" subtitle="All prior unused recovery codes have been invalidated." onClose={onClose}><RecoveryCodes codes={result} onContinue={() => { showToast('New recovery codes saved.', 'success'); onClose(); }} /></Modal>;
  return <Modal title="Regenerate recovery codes" subtitle="Confirm with a current authenticator code. This invalidates every prior unused recovery code." onClose={onClose}><form className="login-form" onSubmit={regenerate}><label>Authenticator app code<input inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={6} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" required /></label>{error && <div className="form-alert"><Icon name="alert" size={16} />{error}</div>}<footer className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={working} icon="refresh">Generate new codes</Button></footer></form></Modal>;
}

function AccountSecurityCard({ showToast, onUserUpdated }) {
  const [refresh, setRefresh] = useState(0); const { loading, error, data } = useRemoteData('/api/auth/mfa/status', refresh); const [setup, setSetup] = useState(false); const [recovery, setRecovery] = useState(false);
  return <section className="surface-card security-card"><div className="card-heading"><div><span className="eyebrow">My account</span><h2>Security</h2></div><span className="security-icon mini"><Icon name="shield" size={19} /></span></div>{loading ? <LoadingBlock rows={2} /> : error ? <ErrorPanel error={error} /> : <><p className="endpoint-note">Use MFA to protect member-care data even if a password is exposed.</p><div className="security-status"><div><strong>Authenticator app</strong><Badge tone={data.totpEnrolled ? 'success' : 'warning'}>{data.totpEnrolled ? 'Enrolled' : 'Not enrolled'}</Badge></div><div><strong>Passkey</strong><Badge tone={data.passkeyEnrolled ? 'success' : 'neutral'}>{data.passkeyEnrolled ? 'Enrolled' : 'Not enrolled'}</Badge></div></div><div className="security-card-actions"><Button type="button" variant="secondary" onClick={() => setSetup(true)}>{data.totpEnrolled || data.passkeyEnrolled ? 'Manage MFA' : 'Set up MFA'}</Button>{data.totpEnrolled && <button className="text-action" type="button" onClick={() => setRecovery(true)}>Recovery codes ({data.recoveryCodesRemaining})</button>}</div></>}{setup && <SecuritySetupModal showToast={showToast} onComplete={onUserUpdated} onClose={() => { setSetup(false); setRefresh((value) => value + 1); }} />}{recovery && <RecoveryCodeRegenerateModal showToast={showToast} onClose={() => { setRecovery(false); setRefresh((value) => value + 1); }} />}</section>;
}

function SettingsPage({ user, refreshKey, onRefresh, showToast }) {
  const { loading, error, data } = useRemoteData('/api/settings', refreshKey);
  const [draft, setDraft] = useState(null);
  const [showEndpoint, setShowEndpoint] = useState(false);
  const [verifyEndpoint, setVerifyEndpoint] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data?.rule) setDraft(data.rule); }, [data]);
  async function saveRule(event) { event.preventDefault(); if (!draft) return; setSaving(true); try { const result = await api('/api/settings/rule', { method: 'PUT', body: draft }); setDraft(result.rule); showToast('Birthday notification rule updated.', 'success'); onRefresh(); } catch (requestError) { showToast(requestError.message, 'danger'); } finally { setSaving(false); } }
  async function toggleEndpoint(endpoint) { try { await api(`/api/endpoints/${endpoint.id}`, { method: 'PATCH', body: { enabled: !endpoint.enabled } }); showToast(`${endpoint.label} ${endpoint.enabled ? 'paused' : 'enabled'}.`, 'success'); onRefresh(); } catch (requestError) { showToast(requestError.message, 'danger'); } }
  if (loading) return <div className="page-content"><LoadingBlock rows={10} /></div>;
  if (error) return <div className="page-content"><ErrorPanel error={error} /></div>;
  return <div className="page-content settings-layout"><section className="settings-main"><div className="section-intro"><Badge tone={data.providerMode === 'mock' ? 'warning' : 'success'} icon={data.providerMode === 'mock' ? 'info' : 'check'}>{data.providerMode === 'mock' ? 'Safe mock delivery mode' : 'Production delivery mode'}</Badge><h2>Birthday-care rule</h2><p>Messages are evaluated server-side in Africa/Lagos. No browser needs to stay open for reminders to work.</p></div>
    {data.canManageRule && draft ? <form className="surface-card settings-form" onSubmit={saveRule}><div className="setting-row"><div><strong>Birthday care reminders</strong><p>Turn the daily operational rule on or off without deleting member records.</p></div><button type="button" role="switch" aria-checked={draft.enabled} className={`switch ${draft.enabled ? 'on' : ''}`} onClick={() => setDraft((state) => ({ ...state, enabled: !state.enabled }))}><span /></button></div><div className="settings-rule-grid"><label>Delivery time<select value={draft.alertTime} onChange={(event) => setDraft((state) => ({ ...state, alertTime: event.target.value }))}>{['06:30', '07:00', '07:30', '08:00', '08:30', '09:00'].map((time) => <option key={time} value={time}>{time} WAT</option>)}</select><small>Timezone: Africa/Lagos</small></label><label>Reminder style<select value={draft.digestMode} onChange={(event) => setDraft((state) => ({ ...state, digestMode: event.target.value }))}><option value="daily_digest">One daily digest</option></select><small>One concise digest is the privacy-preserving v1 policy.</small></label><label>Lead time<select value={draft.daysBefore} onChange={(event) => setDraft((state) => ({ ...state, daysBefore: Number(event.target.value) }))}><option value="0">On the birthday</option><option value="1">1 day before</option><option value="3">3 days before</option><option value="7">7 days before</option></select><small>The system targets the relevant future birthday.</small></label><label>Primary channel<select value={draft.primaryChannel} onChange={(event) => setDraft((state) => ({ ...state, primaryChannel: event.target.value }))}><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select><small>Only consented and verified endpoints are selected.</small></label><label>29 February in non-leap years<select value={draft.feb29Policy} onChange={(event) => setDraft((state) => ({ ...state, feb29Policy: event.target.value }))}><option value="feb28">28 February</option><option value="mar1">1 March</option></select><small>Apply one consistent parish policy.</small></label></div><div className="setting-row compact"><div><strong>SMS fallback</strong><p>Use one verified SMS endpoint only when WhatsApp is unavailable or fails.</p></div><button type="button" role="switch" aria-checked={draft.smsFallback} className={`switch ${draft.smsFallback ? 'on' : ''}`} onClick={() => setDraft((state) => ({ ...state, smsFallback: !state.smsFallback }))}><span /></button></div><footer className="settings-save"><span><Icon name="shield" size={16} />Changes are auditable</span><Button type="submit" loading={saving} icon="check">Save notification rule</Button></footer></form> : <section className="surface-card read-only-rule"><Icon name="lock" size={20} /><div><h3>Rule managed by Organisation Owner</h3><p>Daily digest at {data.rule?.alertTime} WAT · {channelLabel(data.rule?.primaryChannel)} primary</p></div></section>}
  </section>
  <aside className="settings-side"><section className="surface-card endpoints-card"><div className="card-heading"><div><span className="eyebrow">My alert endpoints</span><h2>Verified channels</h2></div><Button variant="secondary" icon="plus" onClick={() => setShowEndpoint(true)}>Add</Button></div><p className="endpoint-note">Consent and SMS proof of number control are required. Phone numbers are never shown to other users.</p><div className="endpoint-list">{data.endpoints.map((endpoint) => <div className="endpoint-item" key={endpoint.id}><span className={`endpoint-icon ${endpoint.channel}`}><Icon name={endpoint.channel === 'whatsapp' ? 'whatsapp' : 'phone'} size={18} /></span><div><strong>{endpoint.label}</strong><small>{endpoint.phone} · Priority {endpoint.priority}</small><span className="endpoint-meta"><Badge tone={endpoint.verifiedAt ? 'success' : 'warning'}>{endpoint.verifiedAt ? 'Verified' : 'Verification required'}</Badge>{endpoint.optedInAt && <Badge tone="aqua">Opt-in recorded</Badge>}{!endpoint.verifiedAt && <button type="button" className="inline-action" onClick={() => setVerifyEndpoint(endpoint)}>Verify</button>}</span></div><button role="switch" aria-checked={endpoint.enabled} className={`switch small ${endpoint.enabled ? 'on' : ''}`} onClick={() => toggleEndpoint(endpoint)} disabled={!endpoint.verifiedAt} aria-label={`${endpoint.enabled ? 'Pause' : 'Enable'} ${endpoint.label}`}><span /></button></div>)}</div>{!data.endpoints.length && <EmptyState icon="phone" title="No alert endpoint" body="Add, document opt-in, and verify a number before requesting delivery." />}</section><AccountSecurityCard showToast={showToast} onUserUpdated={() => onRefresh()} /><section className="privacy-card"><span><Icon name="shield" size={19} /></span><div><strong>Privacy guardrail</strong><p>Alert previews contain only a count and secure dashboard direction. Member contact details stay inside this access-controlled app.</p></div></section></aside>
    {showEndpoint && <AddEndpointModal onClose={() => setShowEndpoint(false)} onAdded={onRefresh} showToast={showToast} />}{verifyEndpoint && <EndpointVerificationModal endpoint={verifyEndpoint} onClose={() => setVerifyEndpoint(null)} onVerified={onRefresh} showToast={showToast} />}
  </div>;
}

function StaffInviteModal({ onClose, onCreated, showToast }) {
  const [form, setForm] = useState({ fullName: '', email: '', role: 'birthday_coordinator', groupScopeText: '' }); const [working, setWorking] = useState(false); const [error, setError] = useState(''); const [created, setCreated] = useState(null);
  async function submit(event) { event.preventDefault(); setError(''); setWorking(true); try { const payload = { ...form, groupScope: form.groupScopeText.split(',').map((value) => value.trim()).filter(Boolean) }; delete payload.groupScopeText; const result = await api('/api/staff/invitations', { method: 'POST', body: payload }); setCreated(result); onCreated(); } catch (requestError) { setError(requestError.message); } finally { setWorking(false); } }
  async function copyLink() { try { await navigator.clipboard.writeText(created.invitation.debugInviteLink); showToast('Safe mock invitation link copied.', 'success'); } catch { showToast('Copy the displayed link manually.', 'info'); } }
  if (created) return <Modal title="Invitation created" subtitle={created.message} onClose={onClose}><div className="invite-created"><Badge tone={created.delivery?.status === 'delivered' ? 'success' : 'danger'}>{statusLabel(created.delivery?.status)}</Badge><p>The recipient must create a password and enrol MFA before access is granted.</p>{created.invitation.debugInviteLink && <div className="demo-verification"><Icon name="info" size={17} /><span><strong>Safe mock email</strong><br />Production sends this private link by email. For this local demo, copy it instead:</span><code className="debug-link">{created.invitation.debugInviteLink}</code><Button type="button" variant="secondary" onClick={copyLink}>Copy link</Button></div>}<Button className="full-width" onClick={onClose}>Done</Button></div></Modal>;
  return <Modal title="Invite a staff member" subtitle="The recipient will receive an email invitation, choose a password, and enrol MFA before receiving any access." onClose={onClose}>
    <form className="member-form" onSubmit={submit}><div className="form-grid"><label>Full name<input value={form.fullName} onChange={(event) => setForm((state) => ({ ...state, fullName: event.target.value }))} required placeholder="e.g. Ruth Okafor" /></label><label>Email address<input type="email" value={form.email} onChange={(event) => setForm((state) => ({ ...state, email: event.target.value }))} required placeholder="staff@church.org" /></label><label>Access role<select value={form.role} onChange={(event) => setForm((state) => ({ ...state, role: event.target.value }))}><option value="owner">Organisation Owner</option><option value="membership_officer">Membership Officer</option><option value="birthday_coordinator">Birthday Coordinator</option><option value="auditor">Auditor</option></select></label><label>Birthday group scope (optional)<input value={form.groupScopeText} onChange={(event) => setForm((state) => ({ ...state, groupScopeText: event.target.value }))} placeholder="Choir, Youth" /><small>For coordinators: leave blank for all groups.</small></label></div><div className="invite-role-guide"><Icon name="shield" size={17} /><span><strong>Least privilege:</strong> Membership Officers manage people; Birthday Coordinators see only their authorised birthday scope; Auditors view history only.</span></div>{error && <div className="form-alert"><Icon name="alert" size={17} />{error}</div>}<footer className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={working} icon="arrowRight">Send invitation</Button></footer></form>
  </Modal>;
}

function StaffAccessPage({ refreshKey, onRefresh, showToast }) {
  const { loading, error, data } = useRemoteData('/api/staff/access', refreshKey); const [showInvite, setShowInvite] = useState(false);
  async function revoke(invitation) { if (!window.confirm(`Revoke the invitation for ${invitation.fullName}?`)) return; try { await api(`/api/staff/invitations/${invitation.id}/revoke`, { method: 'POST' }); showToast('Invitation revoked.', 'success'); onRefresh(); } catch (requestError) { showToast(requestError.message, 'danger'); } }
  async function deactivate(staff) { if (!window.confirm(`Deactivate ${staff.fullName}? They will immediately lose access.`)) return; try { await api(`/api/staff/${staff.id}/deactivate`, { method: 'POST' }); showToast('Staff access deactivated.', 'success'); onRefresh(); } catch (requestError) { showToast(requestError.message, 'danger'); } }
  if (loading) return <div className="page-content"><LoadingBlock rows={9} /></div>;
  if (error) return <div className="page-content"><ErrorPanel error={error} /></div>;
  return <div className="page-content staff-page"><section className="staff-hero"><div><Badge tone="aqua" icon="shield">Least-privilege access</Badge><h2>Care-team access, kept accountable.</h2><p>Every new staff member uses an email invitation and enrols MFA before protected parish data becomes available.</p></div><Button icon="plus" onClick={() => setShowInvite(true)}>Invite staff member</Button></section><section className="surface-card staff-list-card"><div className="table-card-head"><div><h2>Active staff</h2><p>{data.users.length} staff account{data.users.length === 1 ? '' : 's'} in this workspace</p></div><Badge tone="aqua" icon="shield">MFA status visible</Badge></div><div className="staff-list">{data.users.map((staff) => <article className="staff-item" key={staff.id}><Avatar name={staff.fullName} /><div className="staff-main"><strong>{staff.fullName}</strong><small>{staff.email}</small><div className="staff-tags"><Badge tone="neutral">{statusLabel(staff.role)}</Badge>{staff.mfa?.totp && <Badge tone="success">Authenticator</Badge>}{staff.mfa?.passkey && <Badge tone="success">Passkey</Badge>}{!staff.mfa?.totp && !staff.mfa?.passkey && <Badge tone="warning">MFA pending</Badge>}</div>{staff.groupScope?.length > 0 && <small>Scope: {staff.groupScope.join(', ')}</small>}</div><div className="staff-actions">{staff.active && <Button type="button" variant="secondary" onClick={() => deactivate(staff)}>Deactivate</Button>}</div></article>)}</div></section><section className="surface-card staff-list-card"><div className="table-card-head"><div><h2>Recent invitations</h2><p>Invitation email addresses are masked here to reduce unnecessary exposure.</p></div></div>{data.invitations.length ? <div className="invitation-list">{data.invitations.map((invite) => <article className="invitation-item" key={invite.id}><span className="invitation-icon"><Icon name="send" size={18} /></span><div><strong>{invite.fullName}</strong><small>{invite.emailMasked} · {statusLabel(invite.role)}</small><span className="staff-tags"><Badge tone={invite.state === 'accepted' ? 'success' : invite.state === 'pending' ? 'warning' : 'neutral'}>{statusLabel(invite.state)}</Badge><Badge tone={invite.deliveryStatus === 'delivered' ? 'aqua' : 'danger'}>{statusLabel(invite.deliveryStatus || 'pending')}</Badge></span></div><div>{invite.state === 'pending' && <Button type="button" variant="secondary" onClick={() => revoke(invite)}>Revoke</Button>}</div></article>)}</div> : <EmptyState icon="send" title="No staff invitations" body="Invite the next care-team member when you are ready." />}</section>{showInvite && <StaffInviteModal onClose={() => setShowInvite(false)} onCreated={onRefresh} showToast={showToast} />}</div>;
}

function AuditPage({ refreshKey }) {
  const { loading, error, data } = useRemoteData('/api/audit?limit=80', refreshKey);
  return <div className="page-content"><section className="audit-hero"><span className="audit-icon"><Icon name="shield" size={25} /></span><div><Badge tone="aqua">Accountability</Badge><h2>Protected actions, traceable history.</h2><p>The audit log records operational actions without writing raw member data, passwords, tokens, or provider secrets into logs.</p></div></section><section className="surface-card audit-card">{loading ? <LoadingBlock rows={8} /> : error ? <ErrorPanel error={error} /> : data.items.length ? <div className="audit-list">{data.items.map((event) => <article className="audit-item" key={event.id}><span className={`audit-action-icon ${event.action.includes('failed') ? 'alert' : event.action.includes('created') || event.action.includes('succeeded') ? 'success' : ''}`}><Icon name={event.action.includes('login') ? 'lock' : event.action.includes('notification') || event.action.includes('birthday') ? 'bell' : event.action.includes('member') ? 'people' : 'shield'} size={17} /></span><div><strong>{event.summary}</strong><p>{event.actorName || 'System'} · {event.entityType.replace(/_/g, ' ')}</p></div><time>{formatDate(event.createdAt, { day: 'numeric', month: 'short' })}<small>{formatTime(event.createdAt)}</small></time></article>)}</div> : <EmptyState icon="shield" title="No audited events" body="Sign-ins, record changes and operations will appear here." />}</section></div>;
}

function AppShell({ initialUser, onLogout }) {
  const [user, setUser] = useState(initialUser);
  const [page, setPage] = useState('overview');
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState(null);
  const [showMemberForm, setShowMemberForm] = useState(false);
  const [running, setRunning] = useState(false);
  const refresh = () => setRefreshKey((value) => value + 1);
  const showToast = (message, tone = 'success') => setToast({ message, tone });
  async function logout() { try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* client can still clear local view */ } finally { clearCsrfToken(); } onLogout(); }
  async function runDaily() { setRunning(true); try { const result = await api('/api/notifications/run', { method: 'POST', body: {} }); showToast(result.message, 'success'); refresh(); } catch (requestError) { showToast(requestError.message, 'danger'); } finally { setRunning(false); } }
  const shared = { user, refreshKey, onRefresh: refresh, showToast };
  let content;
  if (page === 'members') content = <MembersPage {...shared} onAddMember={() => setShowMemberForm(true)} />;
  else if (page === 'birthdays') content = <BirthdaysPage {...shared} />;
  else if (page === 'deliveries') content = <DeliveriesPage {...shared} />;
  else if (page === 'settings') content = <SettingsPage {...shared} />;
  else if (page === 'staff') content = <StaffAccessPage {...shared} />;
  else if (page === 'audit') content = <AuditPage {...shared} />;
  else content = <OverviewPage {...shared} setPage={setPage} onAddMember={() => setShowMemberForm(true)} onRunDaily={runDaily} running={running} />;
  return <div className="app-shell"><Navigation page={page} setPage={setPage} user={user} onLogout={logout} /><main className="main-area"><Header page={page} user={user} onAddMember={() => setShowMemberForm(true)} onRunDaily={runDaily} running={running} setPage={setPage} /><div className="main-scroll">{content}</div></main><MobileNavigation page={page} setPage={setPage} user={user} />{showMemberForm && <MemberFormModal onClose={() => setShowMemberForm(false)} onSaved={refresh} showToast={showToast} />}<Toast toast={toast} onClose={() => setToast(null)} /></div>;
}

function App() {
  const [state, setState] = useState({ checked: false, user: null, mfaContext: null });
  const invitationToken = window.location.pathname.match(/^\/invite\/([^/]+)$/)?.[1] || null;
  useEffect(() => { api('/api/auth/me').then((result) => setState({ checked: true, user: result.user, mfaContext: null })).catch(() => setState({ checked: true, user: null, mfaContext: null })); }, []);
  function signedIn(user) {
    if (window.location.pathname.startsWith('/invite/')) window.history.replaceState({}, '', '/');
    setState({ checked: true, user, mfaContext: null });
  }
  function beginMfa(result) { setState({ checked: true, user: null, mfaContext: result }); }
  function returnToSignIn() {
    if (window.location.pathname.startsWith('/invite/')) window.history.replaceState({}, '', '/');
    setState({ checked: true, user: null, mfaContext: null });
  }
  if (!state.checked) return <div className="boot-screen"><span className="brand-mark"><Icon name="droplet" size={27} /></span><strong>Living Water</strong><span className="boot-loader" /></div>;
  if (state.user) return <AppShell initialUser={state.user} onLogout={returnToSignIn} />;
  if (state.mfaContext) return <MfaChallengeScreen context={state.mfaContext} onSignedIn={signedIn} onCancel={returnToSignIn} />;
  if (invitationToken) return <InvitationAcceptScreen token={invitationToken} onMfaRequired={beginMfa} onCancel={returnToSignIn} />;
  return <LoginScreen onSignedIn={signedIn} onMfaRequired={beginMfa} />;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
