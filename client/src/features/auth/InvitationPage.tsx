import { useCallback, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { ApiError, invitations } from '../../api/index.js';
import type { MfaMethods, PublicInvitationDto, SafeUser } from '../../api/types.js';
import { useAsync } from '../../hooks/useAsync.js';
import { Button, ErrorPanel } from '../../components/ui.js';
import { PasswordField } from '../../components/PasswordField.js';
import { IconDroplet, IconLock } from '../../components/Icons.js';
import { useSession } from '../../app/session.js';
import { navigate } from '../../app/router.js';
import { formatDate } from '../../lib/format.js';
import { ROLE_LABELS } from '../../lib/status.js';
import { meetsPolicy } from '../../lib/password.js';
import { MfaEnrollment } from './MfaEnrollment.js';

/**
 * Staff invitation acceptance (`/invite/:token`).
 *
 * The link is emailed by the server, so this page must be reachable directly
 * and survive a refresh — it reads the token from the URL rather than state.
 */
export function InvitationPage({ token }: { token: string }): JSX.Element {
  const session = useSession();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [methods, setMethods] = useState<MfaMethods | null>(null);

  const invitation = useAsync(() => invitations.get(token).then((result) => result.invitation), [token], {
    enabled: Boolean(token),
  });

  const accept = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!meetsPolicy(password)) {
        setError('Choose a stronger password: 12+ characters with upper case, lower case and a number.');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await invitations.accept(token, password);
        setMethods(result.methods);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : 'The invitation could not be accepted.');
      } finally {
        setBusy(false);
      }
    },
    [password, token],
  );

  const complete = useCallback(
    (user: SafeUser) => {
      session.adopt(user);
      navigate('/');
    },
    [session],
  );

  if (methods) {
    return (
      <Shell
        title="Set up two-factor authentication"
        intro="Last step — protect your new staff account with a second factor."
      >
        <MfaEnrollment methods={methods} onComplete={complete} />
      </Shell>
    );
  }

  if (invitation.isInitial) {
    return (
      <Shell title="Checking your invitation" intro="Verifying the invitation link.">
        <div className="loading-stack" role="status" aria-busy="true">
          <span className="sr-only">Loading invitation</span>
          <span className="skeleton" style={{ width: '100%', height: 90 }} />
          <span className="skeleton skeleton-row" />
        </div>
      </Shell>
    );
  }

  if (invitation.error || !invitation.data) {
    return (
      <Shell title="Invitation unavailable" intro="This link cannot be used.">
        <ErrorPanel
          title="Invitation invalid or expired"
          message={invitation.error?.message ?? 'Ask an organisation owner to send a new invitation.'}
        />
      </Shell>
    );
  }

  const details: PublicInvitationDto = invitation.data;

  return (
    <Shell
      title={`Welcome, ${details.fullName.split(' ')[0] ?? 'there'}`}
      intro="Create the password for your new staff account."
    >
      <dl className="meta-strip" style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <div>
          <dt className="sr-only">Parish</dt>
          <dd style={{ margin: 0 }}>{details.parishName}</dd>
        </div>
        <div>
          <dt className="sr-only">Role</dt>
          <dd style={{ margin: 0 }}>
            <strong>{ROLE_LABELS[details.role]}</strong>
            {details.groupScope.length ? ` · ${details.groupScope.join(', ')}` : ''}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Expires</dt>
          <dd style={{ margin: 0 }}>This invitation expires on {formatDate(details.expiresAt)}.</dd>
        </div>
      </dl>

      <form className="stack" onSubmit={(event) => void accept(event)} noValidate>
        {error ? (
          <div className="form-alert" role="alert">
            {error}
          </div>
        ) : null}

        <PasswordField value={password} onChange={setPassword} autoFocus invalid={Boolean(error)} error={error} />

        <Button type="submit" variant="primary" full loading={busy} icon={<IconLock />}>
          Create account
        </Button>
        <p className="field-hint">
          You will be asked to enrol an authenticator app or passkey before reaching the dashboard.
        </p>
      </form>
    </Shell>
  );
}

function Shell({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: JSX.Element | JSX.Element[];
}): JSX.Element {
  return (
    <div className="standalone">
      <div className="standalone-inner">
        <div className="auth-card">
          <span className="brand-mark">
            <IconDroplet />
          </span>
          <h1>{title}</h1>
          <p className="standalone-intro">{intro}</p>
          <div className="stack" style={{ marginTop: 'var(--space-6)' }}>
            {children}
          </div>
        </div>
        <p className="standalone-foot">Living Water Mega Parish – RCCG · Birthday Care</p>
      </div>
    </div>
  );
}
