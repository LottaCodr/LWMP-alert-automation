import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { notifications } from '../../api/index.js';
import type { NotificationDto, NotificationStatus } from '../../api/types.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../app/session.js';
import { Button, EmptyState, ErrorPanel, LastUpdated, TableSkeleton } from '../../components/ui.js';
import { NotificationStatusBadge } from '../../components/NotificationStatusBadge.js';
import { IconAlert, IconBell, IconCheck, IconRefresh, IconSparkle } from '../../components/Icons.js';
import { useToasts } from '../../components/Toasts.js';
import { formatDateTime, formatRelative, lagosToday, pluralise } from '../../lib/format.js';
import { describeNotificationStatus } from '../../lib/status.js';

type Filter = 'all' | 'pending' | 'delivered' | 'failed';

const FILTERS: Array<{ value: Filter; label: string; statuses: NotificationStatus[] }> = [
  { value: 'all', label: 'All', statuses: [] },
  {
    value: 'pending',
    label: 'In progress',
    statuses: ['scheduled', 'queued', 'provider_accepted', 'sent', 'retrying'],
  },
  { value: 'delivered', label: 'Delivered', statuses: ['delivered', 'read'] },
  { value: 'failed', label: 'Failed', statuses: ['failed', 'dead_letter'] },
];

/**
 * Delivery log.
 *
 * Every status the backend can produce is documented in a visible legend (not a
 * hover tooltip), failures carry the provider's own error text, and owners can
 * trigger the rule manually when the scheduler has been down.
 */
export function NotificationsPage(): JSX.Element {
  const session = useSession();
  const toasts = useToasts();
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const data = useAsync((signal) => notifications.list(100, signal).then((result) => result.items), [session.user?.id]);

  const rows = useMemo(() => {
    const statuses = FILTERS.find((item) => item.value === filter)?.statuses ?? [];
    if (!statuses.length) return data.data ?? [];
    return (data.data ?? []).filter((item) => statuses.includes(item.status));
  }, [data.data, filter]);

  const counts = useMemo(() => {
    const items = data.data ?? [];
    return {
      all: items.length,
      pending: items.filter((item) =>
        ['scheduled', 'queued', 'provider_accepted', 'sent', 'retrying'].includes(item.status),
      ).length,
      delivered: items.filter((item) => item.status === 'delivered' || item.status === 'read').length,
      failed: items.filter((item) => item.status === 'failed' || item.status === 'dead_letter').length,
    };
  }, [data.data]);

  const sendTest = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await notifications.test();
      toasts.success(result.message);
      data.refresh();
    } catch (cause) {
      toasts.danger(cause instanceof Error ? cause.message : 'The test alert could not be queued.');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await notifications.run(lagosToday());
      toasts.success(result.message);
      data.refresh();
    } catch (cause) {
      toasts.danger(cause instanceof Error ? cause.message : 'The rule could not be evaluated.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">Operations</span>
          <h1>Delivery log</h1>
          <p>
            Every message the parish rule queued, with the provider's delivery receipt. The newest 100 entries are shown
            {session.user?.role === 'owner' ? ' across all staff' : ' for your account'}.
          </p>
        </div>
        <div className="header-actions">
          <Button icon={<IconRefresh />} onClick={data.refresh} loading={data.isRefreshing}>
            Refresh
          </Button>
          <Button icon={<IconBell />} onClick={() => void sendTest()} loading={busy}>
            Send a test alert
          </Button>
          {session.capabilities.canRunNow ? (
            <Button variant="primary" icon={<IconSparkle />} onClick={() => void runNow()} loading={busy}>
              Run today's rule
            </Button>
          ) : null}
        </div>
      </header>

      <section className="surface-card">
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Filter by delivery status">
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
              >
                {item.label} ({counts[item.value]})
              </button>
            ))}
          </div>
          <div className="toolbar-spacer" />
          <LastUpdated timestamp={data.lastUpdated} />
        </div>

        {data.error ? (
          <ErrorPanel title="The delivery log could not load" message={data.error.message} onRetry={data.refresh} />
        ) : data.isInitial ? (
          <TableSkeleton caption="Loading delivery log" rows={8} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconBell />}
            title={
              filter === 'all'
                ? 'No messages yet'
                : `No ${FILTERS.find((item) => item.value === filter)?.label.toLowerCase()} messages`
            }
            description={
              filter === 'all'
                ? 'Once the rule runs, every digest, test message and verification code appears here with its delivery status.'
                : 'Change the filter to see the rest of the log.'
            }
            action={
              filter === 'all' ? (
                <Button icon={<IconBell />} onClick={() => void sendTest()}>
                  Send a test alert
                </Button>
              ) : (
                <Button onClick={() => setFilter('all')}>Show all</Button>
              )
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption>Showing {pluralise(rows.length, 'message')} · newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Recipient</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Type</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    Members
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Scheduled</th>
                  <th scope="col">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <NotificationRow
                    key={item.id}
                    item={item}
                    expanded={expanded === item.id}
                    onToggle={() => setExpanded((current) => (current === item.id ? null : item.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="card-body">
          <h3 style={{ marginBottom: 'var(--space-3)' }}>What each status means</h3>
          <div className="chip-row">
            {(
              [
                'scheduled',
                'queued',
                'provider_accepted',
                'sent',
                'delivered',
                'read',
                'retrying',
                'failed',
                'dead_letter',
              ] as NotificationStatus[]
            ).map((status) => {
              const descriptor = describeNotificationStatus(status);
              return (
                <span key={status} className="row" style={{ gap: 'var(--space-2)', flexWrap: 'nowrap' }}>
                  <NotificationStatusBadge status={status} />
                  <small className="muted">{descriptor.description}</small>
                </span>
              );
            })}
          </div>
        </div>
      </section>
    </>
  );
}

function NotificationRow({
  item,
  expanded,
  onToggle,
}: {
  item: NotificationDto;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <>
      <tr>
        <td>
          <strong>{item.recipientName}</strong>
          <small>
            {item.endpointLabel}
            {item.endpointMasked ? ` · ${item.endpointMasked}` : ''}
          </small>
        </td>
        <td>{item.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</td>
        <td>{item.type === 'birthday_digest' ? 'Birthday digest' : item.type === 'test' ? 'Test' : 'Verification'}</td>
        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{item.memberCount}</td>
        <td>
          <NotificationStatusBadge status={item.status} />
        </td>
        <td>
          <time dateTime={item.scheduledFor}>{formatDateTime(item.scheduledFor)}</time>
          <small>Queued {formatRelative(item.createdAt)}</small>
        </td>
        <td>
          <Button size="sm" variant="ghost" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? 'Hide' : 'Details'}
          </Button>
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={7}>
            <div className="stack-sm" style={{ padding: 'var(--space-2) 0' }}>
              <p style={{ fontSize: 'var(--text-sm)' }}>
                <strong>Message preview:</strong> {item.messagePreview}
              </p>
              <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                Provider: {item.provider ?? '—'} · Provider message id: {item.providerMessageId ?? '—'} · Attempts:{' '}
                {item.attempts} · Notification key: <code>{item.notificationKey}</code>
              </p>
              {item.sentAt ? (
                <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                  Sent {formatDateTime(item.sentAt)}
                  {item.deliveredAt ? ` · delivered ${formatDateTime(item.deliveredAt)}` : ''}
                  {item.readAt ? ` · read ${formatDateTime(item.readAt)}` : ''}
                </p>
              ) : null}
              {item.errorMessage ? (
                <p className="form-alert" style={{ margin: 0 }} role="note">
                  <IconAlert size={16} />
                  <span>
                    <strong>{item.errorCode ?? 'Delivery error'}:</strong> {item.errorMessage}
                  </span>
                </p>
              ) : null}
              {item.status === 'delivered' || item.status === 'read' ? (
                <p className="row" style={{ gap: 'var(--space-2)' }}>
                  <IconCheck size={16} />
                  <small className="muted">Confirmed by the provider — no action needed.</small>
                </p>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
