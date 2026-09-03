import { useCallback, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApiError, auth } from '../../api/index.js';
import type { MfaMethods, SafeUser } from '../../api/types.js';
import { Button, Field, TextAction, TextInput } from '../../components/ui.js';
import { IconFingerprint, IconKey } from '../../components/Icons.js';

type Mode = 'totp' | 'recovery';

/**
 * Second-factor challenge for an account that already has MFA enrolled.
 * Offers the authenticator code, a recovery code, and (when registered) a
 * passkey. Recovery codes are pasteable — WCAG 2.2 SC 3.3.8 requires that
 * authentication not depend on transcription alone.
 */
export function MfaChallenge({
  methods,
  onSuccess,
  onRestart,
}: {
  methods: MfaMethods;
  onSuccess: (user: SafeUser) => void;
  onRestart: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = code.trim();
      if (trimmed.length < 6) {
        setError(
          mode === 'totp' ? 'Enter the six-digit code from your authenticator app.' : 'Enter one recovery code.',
        );
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await auth.verify(mode, trimmed);
        onSuccess(result.user);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : 'Verification failed. Check the code and try again.');
      } finally {
        setBusy(false);
      }
    },
    [code, mode, onSuccess],
  );

  const usePasskey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await auth.mfaPasskeyOptions();
      const response = await startAuthentication({ optionsJSON: options });
      const result = await auth.mfaPasskeyVerify(response);
      onSuccess(result.user);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'NotAllowedError') {
        setError('The passkey prompt was cancelled or timed out. Try again.');
      } else {
        setError(cause instanceof Error ? cause.message : 'Passkey verification failed.');
      }
    } finally {
      setBusy(false);
    }
  }, [onSuccess]);

  return (
    <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
      {error ? (
        <div className="form-alert" role="alert">
          {error}
        </div>
      ) : null}

      <div className="segmented" role="group" aria-label="Verification method">
        <button type="button" aria-pressed={mode === 'totp'} onClick={() => setMode('totp')}>
          Authenticator
        </button>
        <button type="button" aria-pressed={mode === 'recovery'} onClick={() => setMode('recovery')}>
          Recovery code
        </button>
      </div>

      {mode === 'totp' ? (
        <Field label="Authenticator code" htmlFor="mfa-code" required hint="Six digits, refreshed every 30 seconds.">
          <TextInput
            id="mfa-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            placeholder="000000"
            invalid={Boolean(error)}
          />
        </Field>
      ) : (
        <Field label="Recovery code" htmlFor="mfa-recovery" required hint="Paste a saved recovery code.">
          <TextInput
            id="mfa-recovery"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            autoFocus
            placeholder="XXXXX-XXXXX"
            style={{ fontFamily: 'var(--font-mono)' }}
            invalid={Boolean(error)}
          />
        </Field>
      )}

      <Button type="submit" variant="primary" full loading={busy}>
        Verify and sign in
      </Button>

      {methods.passkey ? (
        <Button full icon={<IconFingerprint />} onClick={() => void usePasskey()} loading={busy}>
          Use a passkey
        </Button>
      ) : null}

      <TextAction onClick={onRestart} aria-label="Go back to email and password">
        <IconKey size={14} /> Use a different account
      </TextAction>
    </form>
  );
}
