import { useCallback, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { ApiError, staff } from '../../api/index.js';
import type { InvitationDto, StaffListItem, UserRole } from '../../api/types.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../app/session.js';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  Field,
  SelectInput,
  TableSkeleton,
  TextInput,
} from '../../components/ui.js';
import { Modal } from '../../components/Modal.js';
import { useToasts } from '../../components/Toasts.js';
import { IconCopy, IconMail, IconPlus, IconRefresh, IconTrash } from '../../components/Icons.js';
import { formatDate, formatDateTime, formatRelative, initials } from '../../lib/format.js';
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '../../lib/status.js';

interface Draft {
  fullName: string;
  email: string;
  role: UserRole;
  groupScope: string;
}

const EMPTY_DRAFT: Draft = { fullName: '', email: '', role: 'birthday_coordinator', groupScope: '' };

/**
 * Staff accounts and invitations (owner only).
 *
 * Invitations expire and are single-use; deactivating an account is preferred
 * over deleting it so the audit trail keeps a stable actor identity.
 */
export function StaffPage(): JSX.Element {
  const session = useSession();
  const toasts = useToasts();
  const data = useAsync(() => staff.access(), [session.user?.id], { enabled: session.capabilities.canManageStaff });

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [inviting, setInviting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deactivating, setDeactivating] = useState<StaffListItem | null>(null);
  const [revoking, setRevoking] = useState<InvitationDto | null>(null);
  const [issuedLink, setIssuedLink] = useState<string | null>(null);

  const invite = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (draft.fullName.trim().length < 3 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.email.trim())) {
        setFormError('Enter the full name and a valid email address.');
        return;
      }
      setBusy(true);
      setFormError(null);
      try {
        const result = await staff.invite({
          fullName: draft.fullName.trim(),
          email: draft.email.trim(),
          role: draft.role,
          groupScope: draft.groupScope
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        });
        setIssuedLink(result.debugInviteLink ?? null);
        setInviting(false);
        setDraft(EMPTY_DRAFT);
        toasts.success(result.message);
        data.refresh();
      } catch (cause) {
        setFormError(cause instanceof ApiError ? cause.message : 'The invitation could not be created.');
      } finally {
        setBusy(false);
      }
    },
    [data, draft, toasts],
  );

  const confirmDeactivate = useCallback(async () => {
    if (!deactivating) return;
    setBusy(true);
    try {
      await staff.deactivate(deactivating.id);
      toasts.success(`${deactivating.fullName} can no longer sign in.`);
      setDeactivating(null);
      data.refresh();
    } catch (cause) {
      toasts.danger(cause instanceof ApiError ? cause.message : 'The account could not be deactivated.');
    } finally {
      setBusy(false);
    }
  }, [data, deactivating, toasts]);

  const confirmRevoke = useCallback(async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await staff.revokeInvitation(revoking.id);
      toasts.success('Invitation revoked.');
      setRevoking(null);
      data.refresh();
    } catch (cause) {
      toasts.danger(cause instanceof ApiError ? cause.message : 'The invitation could not be revoked.');
    } finally {
      setBusy(false);
    }
  }, [data, revoking, toasts]);

  if (!session.capabilities.canManageStaff) {
    return (
      <ErrorPanel title="Not available for your role" message="Only an organisation owner can manage staff access." />
    );
  }

  const users = data.data?.users ?? [];
  const invites = data.data?.invitations ?? [];
  const pendingInvites = invites.filter((item) => item.state === 'pending');

  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">Administration</span>
          <h1>Staff & access</h1>
          <p>
            {users.length} account{users.length === 1 ? '' : 's'} · {pendingInvites.length} pending invitation
            {pendingInvites.length === 1 ? '' : 's'}. Every sign-in requires a second factor.
          </p>
        </div>
        <div className="header-actions">
          <Button icon={<IconRefresh />} onClick={data.refresh} loading={data.isRefreshing}>
            Refresh
          </Button>
          <Button variant="primary" icon={<IconPlus />} onClick={() => setInviting(true)}>
            Invite staff
          </Button>
        </div>
      </header>

      {issuedLink ? (
        <div className="form-alert form-alert-info">
          <IconMail />
          <span>
            <strong>Invitation link (demo mode):</strong>{' '}
            <code style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{issuedLink}</code>
            <br />
            In production this link is emailed and never shown in the dashboard.
            <Button
              size="sm"
              variant="ghost"
              icon={<IconCopy />}
              onClick={() =>
                void navigator.clipboard.writeText(issuedLink).then(
                  () => toasts.success('Link copied.'),
                  () => toasts.danger('Copying was blocked by the browser.'),
                )
              }
            >
              Copy link
            </Button>
          </span>
        </div>
      ) : null}

      <Card title="Accounts" description="Deactivating keeps the account's history in the audit trail." padded={false}>
        {data.error ? (
          <ErrorPanel title="Staff access could not load" message={data.error.message} onRetry={data.refresh} />
        ) : data.isInitial ? (
          <TableSkeleton caption="Loading staff accounts" rows={4} />
        ) : users.length === 0 ? (
          <EmptyState
            icon={<IconMail />}
            title="No staff accounts yet"
            description="Invite your first team member to get started."
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption>{users.length} staff accounts</caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Second factor</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="row" style={{ gap: 'var(--space-3)' }}>
                        <Avatar initials={initials(user.fullName)} size="sm" label={user.fullName} />
                        <div>
                          <strong>{user.fullName}</strong>
                          <small>{user.email}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      {ROLE_LABELS[user.role]}
                      {user.groupScope.length ? <small>{user.groupScope.join(', ')}</small> : null}
                    </td>
                    <td>
                      <div className="chip-row">
                        <Badge tone={user.mfa.totp ? 'success' : 'neutral'}>Authenticator</Badge>
                        <Badge tone={user.mfa.passkey ? 'success' : 'neutral'}>Passkey</Badge>
                      </div>
                    </td>
                    <td>
                      {user.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Deactivated</Badge>}
                    </td>
                    <td>
                      <time dateTime={user.createdAt}>{formatDate(user.createdAt)}</time>
                    </td>
                    <td>
                      {user.active && user.id !== session.user?.id ? (
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => setDeactivating(user)}
                          aria-label={`Deactivate ${user.fullName}`}
                        >
                          <IconTrash size={16} />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Invitations" description="Links are single-use and expire after 7 days." padded={false}>
        {invites.length === 0 ? (
          <EmptyState
            icon={<IconMail />}
            title="No invitations issued"
            description="Invite a membership officer, birthday coordinator or auditor to share the workload."
            action={
              <Button variant="primary" icon={<IconPlus />} onClick={() => setInviting(true)}>
                Invite staff
              </Button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption>{invites.length} invitations</caption>
              <thead>
                <tr>
                  <th scope="col">Invited</th>
                  <th scope="col">Role</th>
                  <th scope="col">State</th>
                  <th scope="col">Email delivery</th>
                  <th scope="col">Expires</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invites.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>
                      <strong>{invitation.fullName}</strong>
                      <small>{invitation.emailMasked}</small>
                    </td>
                    <td>{ROLE_LABELS[invitation.role]}</td>
                    <td>
                      <Badge
                        tone={
                          invitation.state === 'pending'
                            ? 'warning'
                            : invitation.state === 'accepted'
                              ? 'success'
                              : invitation.state === 'expired'
                                ? 'neutral'
                                : 'danger'
                        }
                      >
                        {invitation.state === 'pending'
                          ? 'Pending'
                          : invitation.state === 'accepted'
                            ? 'Accepted'
                            : invitation.state === 'expired'
                              ? 'Expired'
                              : 'Revoked'}
                      </Badge>
                    </td>
                    <td>
                      {invitation.deliveryStatus ?? 'Not sent'}
                      {invitation.lastSentAt ? <small>Sent {formatRelative(invitation.lastSentAt)}</small> : null}
                    </td>
                    <td>{formatDateTime(invitation.expiresAt)}</td>
                    <td>
                      {invitation.state === 'pending' ? (
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => setRevoking(invitation)}
                          aria-label={`Revoke invitation for ${invitation.fullName}`}
                        >
                          <IconTrash size={16} />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={inviting}
        title="Invite a staff member"
        description="They choose their own password and must enrol a second factor before reaching the dashboard."
        onClose={() => {
          setInviting(false);
          setFormError(null);
        }}
        footer={
          <>
            <Button onClick={() => setInviting(false)}>Cancel</Button>
            <Button type="submit" form="invite-form" variant="primary" loading={busy}>
              Send invitation
            </Button>
          </>
        }
      >
        <form id="invite-form" className="stack" onSubmit={(event) => void invite(event)} noValidate>
          {formError ? (
            <div className="form-alert" role="alert">
              {formError}
            </div>
          ) : null}

          <Field label="Full name" htmlFor="invite-name" required>
            <TextInput
              id="invite-name"
              value={draft.fullName}
              onChange={(event) => setDraft((current) => ({ ...current, fullName: event.target.value }))}
              autoFocus
            />
          </Field>

          <Field label="Email address" htmlFor="invite-email" required>
            <TextInput
              id="invite-email"
              type="email"
              value={draft.email}
              onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))}
            />
          </Field>

          <Field label="Role" htmlFor="invite-role" required hint={ROLE_DESCRIPTIONS[draft.role]}>
            <SelectInput
              id="invite-role"
              value={draft.role}
              onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value as UserRole }))}
              options={(Object.keys(ROLE_LABELS) as UserRole[]).map((role) => ({
                value: role,
                label: ROLE_LABELS[role],
              }))}
            />
          </Field>

          <Field
            label="Ministry groups"
            htmlFor="invite-groups"
            optional
            hint="Comma separated. Only needed for birthday coordinators, who are limited to these groups."
          >
            <TextInput
              id="invite-groups"
              value={draft.groupScope}
              onChange={(event) => setDraft((current) => ({ ...current, groupScope: event.target.value }))}
              placeholder="Women's Fellowship, Youth Church"
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={Boolean(deactivating)}
        title={`Deactivate ${deactivating?.fullName ?? ''}?`}
        description="They will be signed out immediately and cannot sign in again. Their history stays in the audit trail."
        onClose={() => setDeactivating(null)}
        footer={
          <>
            <Button onClick={() => setDeactivating(null)}>Keep active</Button>
            <Button variant="danger" onClick={() => void confirmDeactivate()} loading={busy}>
              Deactivate account
            </Button>
          </>
        }
      >
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          This cannot be undone from the dashboard. A new invitation would be needed to restore access.
        </p>
      </Modal>

      <Modal
        open={Boolean(revoking)}
        title="Revoke this invitation?"
        description="The link stops working immediately."
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>Keep invitation</Button>
            <Button variant="danger" onClick={() => void confirmRevoke()} loading={busy}>
              Revoke
            </Button>
          </>
        }
      >
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          {revoking?.fullName} will need a new invitation to join.
        </p>
      </Modal>
    </>
  );
}
