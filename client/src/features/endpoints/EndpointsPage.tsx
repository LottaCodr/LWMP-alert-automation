import { useCallback, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { ApiError, endpoints, settings } from '../../api/index.js';
import type { DeliveryChannel, EndpointDto, EndpointVerificationDto } from '../../api/types.js';
import { useAsync } from '../../hooks/useAsync.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  Field,
  SelectInput,
  Switch,
  TableSkeleton,
  TextInput,
} from '../../components/ui.js';
import { Modal } from '../../components/Modal.js';
import { useToasts } from '../../components/Toasts.js';
import { IconCheck, IconMessage, IconPlus, IconRefresh } from '../../components/Icons.js';
import { formatDateTime, formatPhone } from '../../lib/format.js';
import { useSession } from '../../app/session.js';

interface Draft {
  channel: DeliveryChannel;
  phone: string;
  label: string;
  priority: string;
  optIn: boolean;
}

const EMPTY_DRAFT: Draft = { channel: 'whatsapp', phone: '', label: '', priority: '1', optIn: false };

/**
 * Notification endpoints for the signed-in person.
 *
 * A new number must be proved by an SMS code before it can receive alerts, so
 * the parish never messages an unverified number. The opt-in statement is a
 * required acknowledgement, not a pre-ticked box.
 */
export function EndpointsPage(): JSX.Element {
  const session = useSession();
  const toasts = useToasts();
  const data = useAsync(() => settings.get(), [session.user?.id]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState<{ endpoint: EndpointDto; verification: EndpointVerificationDto } | null>(
    null,
  );
  const [code, setCode] = useState('');

  const items = data.data?.endpoints ?? [];

  const create = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!draft.optIn) {
        setFormError('Confirm the opt-in statement before adding this endpoint.');
        return;
      }
      if (draft.phone.replace(/\D/g, '').length < 7 || draft.label.trim().length < 2) {
        setFormError('Enter a label and a valid mobile number.');
        return;
      }
      setBusy(true);
      setFormError(null);
      try {
        const result = await endpoints.create({
          channel: draft.channel,
          phone: draft.phone.trim(),
          label: draft.label.trim(),
          priority: Number(draft.priority) || 1,
          optInConfirmed: true,
        });
        setAdding(false);
        setDraft(EMPTY_DRAFT);
        setCode('');
        setVerifying({ endpoint: result.endpoint, verification: result.verification });
        data.refresh();
      } catch (cause) {
        setFormError(cause instanceof ApiError ? cause.message : 'The endpoint could not be saved.');
      } finally {
        setBusy(false);
      }
    },
    [data, draft],
  );

  const confirmCode = useCallback(async () => {
    if (!verifying) return;
    if (!/^\d{6}$/.test(code)) {
      setFormError('Enter the six-digit code from the SMS.');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const result = await endpoints.confirmVerification(verifying.endpoint.id, code);
      toasts.success(result.message);
      setVerifying(null);
      setCode('');
      data.refresh();
    } catch (cause) {
      setFormError(cause instanceof ApiError ? cause.message : 'The code could not be verified.');
    } finally {
      setBusy(false);
    }
  }, [code, data, toasts, verifying]);

  const resend = useCallback(async () => {
    if (!verifying) return;
    setBusy(true);
    try {
      const result = await endpoints.resendVerification(verifying.endpoint.id);
      setVerifying({ endpoint: verifying.endpoint, verification: result.verification });
      toasts.success(result.message);
    } catch (cause) {
      toasts.danger(cause instanceof Error ? cause.message : 'A new code could not be sent.');
    } finally {
      setBusy(false);
    }
  }, [toasts, verifying]);

  const toggle = useCallback(
    async (endpoint: EndpointDto, patch: { enabled?: boolean; priority?: number }) => {
      try {
        await endpoints.update(endpoint.id, patch);
        toasts.success(
          patch.enabled === undefined ? 'Endpoint updated.' : patch.enabled ? 'Endpoint enabled.' : 'Endpoint paused.',
        );
        data.refresh();
      } catch (cause) {
        toasts.danger(cause instanceof Error ? cause.message : 'The endpoint could not be updated.');
      }
    },
    [data, toasts],
  );

  if (session.user?.role === 'auditor') {
    return (
      <ErrorPanel
        title="Not available for your role"
        message="Auditors have read-only access and do not receive alerts."
      />
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">Your alerts</span>
          <h1>Notification endpoints</h1>
          <p>
            Where your birthday digests are delivered. Numbers are encrypted at rest and each one must be verified by
            SMS before it can receive parish messages.
          </p>
        </div>
        <div className="header-actions">
          <Button icon={<IconRefresh />} onClick={data.refresh} loading={data.isRefreshing}>
            Refresh
          </Button>
          <Button variant="primary" icon={<IconPlus />} onClick={() => setAdding(true)}>
            Add endpoint
          </Button>
        </div>
      </header>

      <Card
        title="Registered endpoints"
        description={
          data.data
            ? `Provider mode: ${data.data.providerMode}. The lowest priority number is tried first; SMS fallback applies when the rule allows it.`
            : undefined
        }
        padded={false}
      >
        {data.error ? (
          <ErrorPanel title="Endpoints could not load" message={data.error.message} onRetry={data.refresh} />
        ) : data.isInitial ? (
          <TableSkeleton caption="Loading endpoints" rows={3} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<IconMessage />}
            title="No endpoints yet"
            description="Add the mobile number that should receive your birthday digests. You will be sent a six-digit verification code."
            action={
              <Button variant="primary" icon={<IconPlus />} onClick={() => setAdding(true)}>
                Add your first endpoint
              </Button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption>
                {items.length} endpoint{items.length === 1 ? '' : 's'} for {session.user?.fullName}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Channel</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    Priority
                  </th>
                  <th scope="col">Verification</th>
                  <th scope="col">Active</th>
                </tr>
              </thead>
              <tbody>
                {items.map((endpoint) => (
                  <tr key={endpoint.id}>
                    <td>
                      <strong>{endpoint.label}</strong>
                      <small>{formatPhone(endpoint.phone ?? endpoint.phoneMasked)}</small>
                    </td>
                    <td>{endpoint.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <SelectInput
                        id={`priority-${endpoint.id}`}
                        aria-label={`Priority for ${endpoint.label}`}
                        value={String(endpoint.priority)}
                        onChange={(event) => void toggle(endpoint, { priority: Number(event.target.value) })}
                        options={Array.from({ length: 10 }, (_, index) => ({
                          value: String(index + 1),
                          label: String(index + 1),
                        }))}
                        style={{ width: 76, minHeight: 34 }}
                      />
                    </td>
                    <td>
                      {endpoint.verifiedAt ? (
                        <Badge tone="success">Verified {formatDateTime(endpoint.verifiedAt)}</Badge>
                      ) : (
                        <div className="row" style={{ gap: 'var(--space-2)' }}>
                          <Badge tone="warning">Not verified</Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setVerifying({ endpoint, verification: { expiresAt: '', deliveryMode: 'sms' } })
                            }
                          >
                            Verify
                          </Button>
                        </div>
                      )}
                    </td>
                    <td>
                      <Switch
                        checked={endpoint.enabled}
                        onChange={(next) => void toggle(endpoint, { enabled: next })}
                        label={`${endpoint.enabled ? 'Pause' : 'Enable'} ${endpoint.label}`}
                        size="sm"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={adding}
        title="Add a notification endpoint"
        description="This number will receive your birthday digests. It is encrypted before it is stored."
        onClose={() => {
          setAdding(false);
          setFormError(null);
        }}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="submit" form="endpoint-form" variant="primary" loading={busy}>
              Send verification code
            </Button>
          </>
        }
      >
        <form id="endpoint-form" className="stack" onSubmit={(event) => void create(event)} noValidate>
          {formError ? (
            <div className="form-alert" role="alert">
              {formError}
            </div>
          ) : null}

          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <Field label="Channel" htmlFor="endpoint-channel" required>
              <SelectInput
                id="endpoint-channel"
                value={draft.channel}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, channel: event.target.value as DeliveryChannel }))
                }
                options={[
                  { value: 'whatsapp', label: 'WhatsApp' },
                  { value: 'sms', label: 'SMS' },
                ]}
              />
            </Field>
            <Field label="Priority" htmlFor="endpoint-priority" hint="1 is tried first.">
              <SelectInput
                id="endpoint-priority"
                value={draft.priority}
                onChange={(event) => setDraft((current) => ({ ...current, priority: event.target.value }))}
                options={Array.from({ length: 10 }, (_, index) => ({
                  value: String(index + 1),
                  label: String(index + 1),
                }))}
              />
            </Field>
          </div>

          <Field label="Label" htmlFor="endpoint-label" required hint="For example “Personal WhatsApp”.">
            <TextInput
              id="endpoint-label"
              value={draft.label}
              onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
              autoFocus
            />
          </Field>

          <Field
            label="Mobile number"
            htmlFor="endpoint-phone"
            required
            hint="Nigerian format: 0803 123 4567 or +234 803 123 4567."
          >
            <TextInput
              id="endpoint-phone"
              type="tel"
              value={draft.phone}
              onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))}
            />
          </Field>

          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.optIn}
              onChange={(event) => setDraft((current) => ({ ...current, optIn: event.target.checked }))}
            />
            <span>
              <strong>I confirm opt-in for parish notifications</strong>
              <small>
                This number belongs to me (or I have its owner's permission) and may receive birthday care messages from
                Living Water Mega Parish.
              </small>
            </span>
          </label>
        </form>
      </Modal>

      <Modal
        open={Boolean(verifying)}
        title="Verify this number"
        description="We sent a six-digit code by SMS. Codes expire after ten minutes."
        onClose={() => {
          setVerifying(null);
          setCode('');
          setFormError(null);
        }}
        footer={
          <>
            <Button onClick={() => void resend()} loading={busy}>
              Resend code
            </Button>
            <Button variant="primary" onClick={() => void confirmCode()} loading={busy}>
              Verify
            </Button>
          </>
        }
      >
        <div className="stack">
          {formError ? (
            <div className="form-alert" role="alert">
              {formError}
            </div>
          ) : null}

          {verifying?.verification.debugCode ? (
            <p className="form-alert form-alert-info">
              <IconCheck size={16} />
              <span>
                Demo mode: the verification code is <strong>{verifying.verification.debugCode}</strong>. In production
                this code is only ever sent by SMS.
              </span>
            </p>
          ) : null}

          <Field label="Verification code" htmlFor="endpoint-code" required>
            <TextInput
              id="endpoint-code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="000000"
              style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.3em' }}
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}
