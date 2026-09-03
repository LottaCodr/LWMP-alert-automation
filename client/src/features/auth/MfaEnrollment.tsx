import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { ApiError, auth } from '../../api/index.js';
import type { MfaMethods, SafeUser, TotpEnrollmentDto } from '../../api/types.js';
import { Button, ErrorPanel, Field, TextInput } from '../../components/ui.js';
import { IconCheck, IconCopy, IconDownload, IconFingerprint } from '../../components/Icons.js';
import { useToasts } from '../../components/Toasts.js';
import { formatDateTime } from '../../lib/format.js';

type Stage = 'loading' | 'scan' | 'recovery' | 'failed';

/**
 * First-time multi-factor enrollment.
 *
 * The server will not grant a full session until this completes, so the flow is
 * deliberately linear: scan → confirm → save recovery codes → continue.
 * Recovery codes are shown exactly once, and the "I have saved them" step is a
 * real gate rather than a toast.
 */
export function MfaEnrollment({
  methods,
  onComplete,
}: {
  methods: MfaMethods;
  onComplete: (user: SafeUser) => void;
}): JSX.Element {
  const toasts = useToasts();
  const [stage, setStage] = useState<Stage>('loading');
  const [enrollment, setEnrollment] = useState<TotpEnrollmentDto | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [enrolledUser, setEnrolledUser] = useState<SafeUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    auth
      .startTotpEnrollment()
      .then((response) => {
        if (cancelled) return;
        setEnrollment(response.enrollment);
        setStage('scan');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Could not start authenticator setup.');
        setStage('failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const confirm = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!/^\d{6}$/.test(code)) {
        setError('Enter the six-digit code from your authenticator app.');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await auth.confirmTotpEnrollment(code);
        setRecoveryCodes(result.recoveryCodes);
        setEnrolledUser(result.user);
        setStage('recovery');
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : 'Verification failed. Try the next code in your app.');
      } finally {
        setBusy(false);
      }
    },
    [code],
  );

  const registerPasskey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await auth.passkeyRegistrationOptions();
      const response = await startRegistration({ optionsJSON: options });
      const result = await auth.passkeyRegistrationVerify(response);
      toasts.success('Passkey enrolled. You can use it as your second factor.');
      onComplete(result.user);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'NotAllowedError') {
        setError('The passkey prompt was cancelled. Try again, or use the authenticator app instead.');
      } else {
        setError(cause instanceof Error ? cause.message : 'Passkey registration failed.');
      }
    } finally {
      setBusy(false);
    }
  }, [onComplete, toasts]);

  const copyCodes = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      toasts.success('Recovery codes copied to the clipboard.');
    } catch {
      toasts.danger('Copying was blocked by the browser. Write the codes down manually.');
    }
  }, [recoveryCodes, toasts]);

  const downloadCodes = useCallback(() => {
    const blob = new Blob([`${recoveryCodes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'living-water-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }, [recoveryCodes]);

  if (stage === 'failed') {
    return (
      <ErrorPanel
        title="Authenticator setup could not start"
        message={error ?? 'Unknown error.'}
        onRetry={() => window.location.reload()}
      />
    );
  }

  if (stage === 'loading' || !enrollment) {
    return (
      <div className="loading-stack" role="status" aria-busy="true">
        <span className="sr-only">Preparing authenticator setup</span>
        <span className="skeleton skeleton-title" />
        <span className="skeleton" style={{ width: '100%', height: 180 }} />
      </div>
    );
  }

  if (stage === 'recovery') {
    return (
      <div className="stack">
        <div className="form-alert form-alert-info">
          <IconCheck />
          <div>
            <strong>Authenticator enrolled.</strong> These recovery codes are shown once. Each one can be used in place
            of a code from your app if you lose your phone.
          </div>
        </div>

        <div className="recovery-code-list">
          {recoveryCodes.map((value) => (
            <code key={value}>{value}</code>
          ))}
        </div>

        <div className="row">
          <Button icon={<IconCopy />} onClick={() => void copyCodes()}>
            Copy codes
          </Button>
          <Button icon={<IconDownload />} onClick={downloadCodes}>
            Download .txt
          </Button>
        </div>

        <label className="check-row">
          <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
          <span>
            <strong>I have stored these codes safely</strong>
            <small>They will not be shown again and cannot be recovered later.</small>
          </span>
        </label>

        <Button
          variant="primary"
          full
          disabled={!saved || !enrolledUser}
          onClick={() => enrolledUser && onComplete(enrolledUser)}
        >
          Continue to the dashboard
        </Button>
        <p className="field-hint">Enrollment finished at {formatDateTime(new Date())}.</p>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={(event) => void confirm(event)} noValidate>
      {error ? (
        <div className="form-alert" role="alert">
          {error}
        </div>
      ) : null}

      <p className="muted" style={{ fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-relaxed)' }}>
        Scan the code with any authenticator app (Google Authenticator, 1Password, Authy), or enter the manual key. The
        code changes every 30 seconds.
      </p>

      <img
        src={enrollment.qrCodeDataUrl}
        alt={`QR code for ${enrollment.issuer}`}
        width={196}
        height={196}
        style={{ borderRadius: 10 }}
      />

      <Field label="Manual key" htmlFor="manual-key" hint="Use this if the camera cannot read the QR code.">
        <div className="row">
          <TextInput id="manual-key" readOnly value={enrollment.manualKey} style={{ fontFamily: 'var(--font-mono)' }} />
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(enrollment.manualKey).then(
                () => toasts.success('Manual key copied.'),
                () => toasts.danger('Copying was blocked by the browser.'),
              );
            }}
            icon={<IconCopy />}
            aria-label="Copy manual key"
          />
        </div>
      </Field>

      <Field
        label="Six-digit code"
        htmlFor="totp-code"
        required
        error={error && !/^\d{6}$/.test(code) ? error : null}
        hint="Enter the current code to finish enrollment."
      >
        <TextInput
          id="totp-code"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          placeholder="000000"
          invalid={Boolean(error) && !/^\d{6}$/.test(code)}
        />
      </Field>

      <Button type="submit" variant="primary" full loading={busy}>
        Verify and continue
      </Button>

      {methods.passkey ? (
        <>
          <div className="row" style={{ justifyContent: 'center' }}>
            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              or
            </span>
          </div>
          <Button full icon={<IconFingerprint />} onClick={() => void registerPasskey()} loading={busy}>
            Use a passkey instead
          </Button>
        </>
      ) : null}
    </form>
  );
}
