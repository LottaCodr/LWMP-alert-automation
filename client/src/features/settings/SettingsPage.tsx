import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { ApiError, auth, normaliseParish, settings } from '../../api/index.js';
import type { DeliveryChannel, Feb29Policy, MfaStatusDto, RulePayload } from '../../api/types.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../app/session.js';
import { Badge, Button, Card, ErrorPanel, Field, SelectInput, Switch, TextInput } from '../../components/ui.js';
import { Modal } from '../../components/Modal.js';
import { useToasts } from '../../components/Toasts.js';
import { IconCopy, IconFingerprint, IconKey, IconShield } from '../../components/Icons.js';
import { formatDateTime } from '../../lib/format.js';
import { ROLE_DESCRIPTIONS } from '../../lib/status.js';

/**
 * Parish settings and personal security.
 *
 * The notification rule is owner-only; everyone else sees the effective rule
 * read-only so coordinators know when a digest will arrive. Personal security
 * (recovery codes, passkeys) is always available to the signed-in person.
 */
export function SettingsPage(): JSX.Element {
  const session = useSession();
  const toasts = useToasts();
  const data = useAsync(() => settings.get(), [session.user?.id]);
  const mfa = useAsync(() => auth.mfaStatus(), [session.user?.id]);

  const [draft, setDraft] = useState<RulePayload | null>(null);
  const [saving, setSaving] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rule = data.data?.rule ?? null;
  const canManage = data.data?.canManageRule ?? false;
  const parish = normaliseParish(null);

  useEffect(() => {
    if (!rule) return;
    setDraft({
      enabled: rule.enabled,
      digestMode: 'daily_digest',
      alertTime: rule.alertTime,
      daysBefore: rule.daysBefore,
      primaryChannel: rule.primaryChannel,
      smsFallback: rule.smsFallback,
      feb29Policy: rule.feb29Policy,
    });
  }, [rule]);

  const saveRule = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!draft) return;
      const payload: RulePayload = { ...draft };
      setSaving(true);
      try {
        await settings.updateRule(payload);
        toasts.success('Notification rule saved. The next run uses these settings.');
        data.refresh();
      } catch (cause) {
        toasts.danger(cause instanceof ApiError ? cause.message : 'The rule could not be saved.');
      } finally {
        setSaving(false);
      }
    },
    [data, draft, toasts],
  );

  const patchRule = useCallback(
    (patch: Partial<RulePayload>) => {
      if (!canManage) return;
      setDraft((current) => (current ? { ...current, ...patch } : current));
    },
    [canManage],
  );

  const regenerate = useCallback(async () => {
    if (!/^\d{6}$/.test(recoveryCode)) {
      setRecoveryError('Enter your current six-digit authenticator code.');
      return;
    }
    setBusy(true);
    setRecoveryError(null);
    try {
      const result = await auth.recoveryCodes(recoveryCode);
      setRecoveryCodes(result.recoveryCodes);
      toasts.success(result.message);
      mfa.refresh();
    } catch (cause) {
      setRecoveryError(cause instanceof ApiError ? cause.message : 'Recovery codes could not be regenerated.');
    } finally {
      setBusy(false);
    }
  }, [mfa, recoveryCode, toasts]);

  const addPasskey = useCallback(async () => {
    setBusy(true);
    try {
      const { options } = await auth.passkeyRegistrationOptions();
      const response = await startRegistration({ optionsJSON: options });
      await auth.passkeyRegistrationVerify(response);
      toasts.success('Passkey enrolled for this device.');
      mfa.refresh();
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'NotAllowedError') {
        toasts.danger('The passkey prompt was cancelled.');
      } else {
        toasts.danger(cause instanceof Error ? cause.message : 'Passkey registration failed.');
      }
    } finally {
      setBusy(false);
    }
  }, [mfa, toasts]);

  const status: MfaStatusDto | undefined = mfa.data;

  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">{parish.parishName}</span>
          <h1>Settings</h1>
          <p>
            The parish notification rule, your personal security settings and the delivery provider currently in use (
            {data.data?.providerMode ?? 'loading'}).
          </p>
        </div>
      </header>

      {data.error ? (
        <ErrorPanel title="Settings could not load" message={data.error.message} onRetry={data.refresh} />
      ) : null}

      <Card
        title="Notification rule"
        description={
          canManage
            ? 'Applies to every staff endpoint. Changes take effect on the next scheduled run.'
            : 'Only an organisation owner can change the rule. This is what is currently configured.'
        }
        eyebrow={rule?.enabled ? 'Enabled' : 'Disabled'}
      >
        {data.isInitial || !rule ? (
          <div className="loading-stack" role="status" aria-busy="true">
            <span className="sr-only">Loading the notification rule</span>
            <span className="skeleton skeleton-title" />
            <span className="skeleton skeleton-row" />
          </div>
        ) : (
          <form id="rule-form" className="stack" onSubmit={(event) => void saveRule(event)} noValidate>
            <div className="setting-row" style={{ padding: 0 }}>
              <div>
                <h3>Automated birthday delivery</h3>
                <p>When off, the rule is evaluated but nothing is sent — useful for a quiet season.</p>
              </div>
              <Switch
                checked={draft?.enabled ?? rule.enabled}
                onChange={(next) => patchRule({ enabled: next })}
                label="Enable automated birthday delivery"
                disabled={!canManage}
              />
            </div>

            <div className="setting-row" style={{ padding: 0 }}>
              <div>
                <h3>Daily digest time</h3>
                <p>One consolidated message per person per day, sent at this time in {rule.timezone}.</p>
              </div>
              <div className="setting-control">
                <TextInput
                  id="rule-time"
                  type="time"
                  value={draft?.alertTime ?? rule.alertTime}
                  onChange={(event) => patchRule({ alertTime: event.target.value })}
                  disabled={!canManage}
                  readOnly={!canManage}
                  aria-label="Digest time"
                  style={{ width: 140 }}
                />
              </div>
            </div>

            <div className="setting-row" style={{ padding: 0 }}>
              <div>
                <h3>Advance notice</h3>
                <p>How many days ahead of a birthday the digest should mention it.</p>
              </div>
              <div className="setting-control">
                <SelectInput
                  id="rule-days"
                  value={String(draft?.daysBefore ?? rule.daysBefore)}
                  onChange={(event) => patchRule({ daysBefore: Number(event.target.value) })}
                  disabled={!canManage}
                  aria-label="Days before the birthday"
                  options={Array.from({ length: 15 }, (_, index) => ({
                    value: String(index),
                    label: `${index} day${index === 1 ? '' : 's'}`,
                  }))}
                  style={{ width: 140 }}
                />
              </div>
            </div>

            <div className="setting-row" style={{ padding: 0 }}>
              <div>
                <h3>Primary channel</h3>
                <p>WhatsApp is preferred where the number is registered; SMS is the fallback.</p>
              </div>
              <div className="setting-control">
                <SelectInput
                  id="rule-channel"
                  value={draft?.primaryChannel ?? rule.primaryChannel}
                  onChange={(event) => patchRule({ primaryChannel: event.target.value as DeliveryChannel })}
                  disabled={!canManage}
                  aria-label="Primary delivery channel"
                  options={[
                    { value: 'whatsapp', label: 'WhatsApp' },
                    { value: 'sms', label: 'SMS' },
                  ]}
                  style={{ width: 140 }}
                />
              </div>
            </div>

            <div className="setting-row" style={{ padding: 0 }}>
              <div>
                <h3>SMS fallback</h3>
                <p>Retry over SMS when the primary channel reports a failure.</p>
              </div>
              <Switch
                checked={draft?.smsFallback ?? rule.smsFallback}
                onChange={(next) => patchRule({ smsFallback: next })}
                label="Enable SMS fallback"
                disabled={!canManage}
              />
            </div>

            <div className="setting-row" style={{ padding: 0 }}>
              <div>
                <h3>29 February birthdays</h3>
                <p>In a non-leap year, treat these birthdays as falling on the chosen date.</p>
              </div>
              <div className="setting-control">
                <SelectInput
                  id="rule-feb29"
                  value={draft?.feb29Policy ?? rule.feb29Policy}
                  onChange={(event) => patchRule({ feb29Policy: event.target.value as Feb29Policy })}
                  disabled={!canManage}
                  aria-label="Policy for 29 February birthdays"
                  options={[
                    { value: 'feb28', label: '28 February' },
                    { value: 'mar1', label: '1 March' },
                  ]}
                  style={{ width: 160 }}
                />
              </div>
            </div>

            <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Last updated {formatDateTime(rule.updatedAt)} · digest mode: {rule.digestMode.replace('_', ' ')}
            </p>

            {canManage ? (
              <Button type="submit" variant="primary" loading={saving}>
                Save rule
              </Button>
            ) : null}
          </form>
        )}
      </Card>

      <Card
        title="Your security"
        description="Two-factor authentication protects every staff account on this workspace."
        eyebrow={session.user?.email}
        action={
          <Button icon={<IconFingerprint />} onClick={() => void addPasskey()} loading={busy}>
            Add a passkey
          </Button>
        }
      >
        <div className="stack">
          <div className="setting-row" style={{ padding: 0 }}>
            <div>
              <h3>Authenticator app</h3>
              <p>
                {status?.totpEnrolled
                  ? `Enrolled on ${formatDateTime(status.enrolledAt)}.`
                  : 'Not enrolled. Ask an owner to reset your account if you need to re-enrol.'}
              </p>
            </div>
            <Badge tone={status?.totpEnrolled ? 'success' : 'warning'}>
              {status?.totpEnrolled ? 'Enrolled' : 'Not enrolled'}
            </Badge>
          </div>

          <div className="setting-row" style={{ padding: 0 }}>
            <div>
              <h3>Passkey</h3>
              <p>
                {status?.passkeyEnrolled
                  ? 'At least one passkey is registered for this account.'
                  : 'No passkey registered yet.'}
              </p>
            </div>
            <Badge tone={status?.passkeyEnrolled ? 'success' : 'neutral'}>
              {status?.passkeyEnrolled ? 'Enabled' : 'Not set up'}
            </Badge>
          </div>

          <div className="setting-row" style={{ padding: 0 }}>
            <div>
              <h3>Recovery codes</h3>
              <p>
                {status
                  ? `${status.recoveryCodesRemaining} unused code${status.recoveryCodesRemaining === 1 ? '' : 's'} remaining.`
                  : 'Loading…'}{' '}
                Regenerating replaces every unused code.
              </p>
            </div>
            <Button icon={<IconKey />} onClick={() => setRecoveryOpen(true)}>
              Regenerate codes
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Your access" description="What your role allows you to do in this workspace.">
        <div className="stack-sm">
          <p>
            <strong>{session.roleLabel || session.user?.role}</strong>
          </p>
          <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            {session.user ? ROLE_DESCRIPTIONS[session.user.role] : ''}
          </p>
          {session.user?.groupScope.length ? (
            <div className="chip-row">
              {session.user.groupScope.map((group) => (
                <span className="filter-chip" key={group}>
                  {group}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </Card>

      <Modal
        open={recoveryOpen}
        title="Regenerate recovery codes"
        description="All previously issued, unused codes will stop working immediately."
        onClose={() => {
          setRecoveryOpen(false);
          setRecoveryCodes(null);
          setRecoveryCode('');
          setRecoveryError(null);
        }}
        footer={
          recoveryCodes ? (
            <>
              <Button
                icon={<IconCopy />}
                onClick={() => {
                  void navigator.clipboard.writeText(recoveryCodes.join('\n')).then(
                    () => toasts.success('Recovery codes copied.'),
                    () => toasts.danger('Copying was blocked by the browser.'),
                  );
                }}
              >
                Copy
              </Button>
              <Button variant="primary" onClick={() => setRecoveryOpen(false)}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => setRecoveryOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void regenerate()} loading={busy}>
                Regenerate
              </Button>
            </>
          )
        }
      >
        {recoveryCodes ? (
          <div className="stack">
            <p className="form-alert form-alert-info">
              <IconShield size={16} />
              <span>Store these somewhere safe. They are shown once and each one can be used a single time.</span>
            </p>
            <div className="recovery-code-list">
              {recoveryCodes.map((code) => (
                <code key={code}>{code}</code>
              ))}
            </div>
          </div>
        ) : (
          <div className="stack">
            {recoveryError ? (
              <div className="form-alert" role="alert">
                {recoveryError}
              </div>
            ) : null}
            <Field
              label="Current authenticator code"
              htmlFor="regenerate-code"
              required
              hint="Confirms you still hold the device."
            >
              <TextInput
                id="regenerate-code"
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoFocus
                placeholder="000000"
              />
            </Field>
          </div>
        )}
      </Modal>
    </>
  );
}
