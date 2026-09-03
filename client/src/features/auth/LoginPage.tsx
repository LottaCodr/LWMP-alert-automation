import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, JSX, ReactNode } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApiError, auth } from '../../api/index.js';
import type { DemoAccount, MfaMethods, SafeUser } from '../../api/types.js';
import { Button, Field, TextInput } from '../../components/ui.js';
import { IconDroplet, IconEye, IconEyeOff, IconFingerprint } from '../../components/Icons.js';
import { useSession } from '../../app/session.js';
import { navigate } from '../../app/router.js';
import { MfaChallenge } from './MfaChallenge.js';
import { MfaEnrollment } from './MfaEnrollment.js';

type Stage = 'credentials' | 'challenge' | 'enrollment';

interface ChallengeState {
  methods: MfaMethods;
  account: SafeUser | null;
}

/**
 * Sign-in page.
 *
 * Password first, then a second factor. The demo credential list is only
 * rendered when the API actually exposes it (`SEED_DEMO_DATA` outside
 * production) so a production deployment never advertises accounts.
 */
export function LoginPage(): JSX.Element {
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>('credentials');
  const [challenge, setChallenge] = useState<ChallengeState | null>(null);
  const [demo, setDemo] = useState<{ password: string; accounts: DemoAccount[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    auth
      .demoAccounts()
      .then((result) => {
        if (!cancelled) setDemo(result);
      })
      .catch(() => {
        /* Demo hints are intentionally absent in production. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const complete = useCallback(
    (user: SafeUser) => {
      session.adopt(user);
      navigate('/');
    },
    [session],
  );

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!email.trim() || !password) {
        setError('Enter your email address and password.');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await auth.login(email.trim(), password);
        if (result.requiresMfa && result.methods) {
          setChallenge({ methods: result.methods, account: result.user ?? null });
          setStage(result.enrollmentRequired ? 'enrollment' : 'challenge');
          return;
        }
        if (result.user) complete(result.user);
        else await session.refresh();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : 'Sign-in failed. Check your connection and try again.');
      } finally {
        setBusy(false);
      }
    },
    [complete, email, password, session],
  );

  const signInWithPasskey = useCallback(async () => {
    if (!email.trim()) {
      setError('Enter the email address linked to your passkey first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { options } = await auth.passkeyOptions(email.trim());
      const response = await startAuthentication({ optionsJSON: options });
      const result = await auth.passkeyVerify(response);
      complete(result.user);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'NotAllowedError') {
        setError('The passkey prompt was cancelled or timed out.');
      } else {
        setError(cause instanceof Error ? cause.message : 'Passkey sign-in failed.');
      }
    } finally {
      setBusy(false);
    }
  }, [complete, email]);

  if (stage === 'challenge' && challenge) {
    return (
      <AuthShell title="Confirm your identity" intro="Enter the code from your authenticator app to continue.">
        <MfaChallenge
          methods={challenge.methods}
          onSuccess={complete}
          onRestart={() => {
            setChallenge(null);
            setStage('credentials');
            setPassword('');
          }}
        />
      </AuthShell>
    );
  }

  if (stage === 'enrollment' && challenge) {
    return (
      <AuthShell
        title="Set up two-factor authentication"
        intro="This parish protects staff accounts with a second factor. It takes about a minute and is required once."
      >
        <MfaEnrollment methods={challenge.methods} onComplete={complete} />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Sign in" intro="Access the Living Water Mega Parish birthday care dashboard.">
      <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
        {error ? (
          <div className="form-alert" role="alert">
            {error}
          </div>
        ) : null}

        <Field label="Email address" htmlFor="login-email" required>
          <TextInput
            id="login-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            autoFocus
            required
            invalid={Boolean(error)}
          />
        </Field>

        <Field label="Password" htmlFor="login-password" required>
          <div style={{ position: 'relative' }}>
            <TextInput
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              invalid={Boolean(error)}
              style={{ paddingRight: 48 }}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowPassword((current) => !current)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              style={{ position: 'absolute', right: 4, top: 2 }}
            >
              {showPassword ? <IconEyeOff /> : <IconEye />}
            </button>
          </div>
        </Field>

        <Button type="submit" variant="primary" full loading={busy}>
          Continue
        </Button>

        <Button full icon={<IconFingerprint />} onClick={() => void signInWithPasskey()} loading={busy}>
          Sign in with a passkey
        </Button>
      </form>

      {demo && demo.accounts.length ? (
        <div className="stack-sm" style={{ marginTop: 'var(--space-6)' }}>
          <span className="eyebrow">Demo workspace</span>
          <p className="muted" style={{ fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-relaxed)' }}>
            These seeded accounts exist only while demo data is enabled. Password for all of them:{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>{demo.password}</code>
          </p>
          <div className="stack-sm">
            {demo.accounts.map((account) => (
              <button
                key={account.email}
                type="button"
                className="check-row"
                style={{ width: '100%', textAlign: 'left' }}
                onClick={() => {
                  setEmail(account.email);
                  setPassword(demo.password);
                }}
              >
                <span>
                  <strong>{account.name}</strong>
                  <small>
                    {account.roleLabel} · {account.email}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </AuthShell>
  );
}

function AuthShell({ title, intro, children }: { title: string; intro: string; children: ReactNode }): JSX.Element {
  return (
    <div className="standalone">
      <div className="standalone-inner">
        <div className="auth-card">
          <span className="brand-mark">
            <IconDroplet />
          </span>
          <h1>{title}</h1>
          <p className="standalone-intro">{intro}</p>
          <div style={{ marginTop: 'var(--space-6)' }}>{children}</div>
        </div>
        <p className="standalone-foot">
          Living Water Mega Parish – RCCG · Birthday Care
          <br />
          Member phone numbers are encrypted at rest and masked unless your role permits viewing them.
        </p>
      </div>
    </div>
  );
}
