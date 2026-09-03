import { useCallback, useState } from 'react';
import type { JSX } from 'react';
import { dashboard, normaliseParish, notifications } from '../../api/index.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../app/session.js';
import { navigate } from '../../app/router.js';
import { Button, Card, ErrorPanel, LastUpdated, TableSkeleton } from '../../components/ui.js';
import { BirthdayList } from '../../components/BirthdayList.js';
import { NotificationStatusBadge } from '../../components/NotificationStatusBadge.js';
import {
  IconAlert,
  IconCake,
  IconCheck,
  IconClock,
  IconRefresh,
  IconUsers,
  IconSparkle,
} from '../../components/Icons.js';
import { useToasts } from '../../components/Toasts.js';
import { formatDate, formatDateTime, formatPercent, formatRelative, lagosToday, pluralise } from '../../lib/format.js';

/**
 * Operational overview.
 *
 * Six KPIs maximum (any more stops being readable at a glance), each with a
 * concrete next step, plus the two lists staff actually work from: who is
 * celebrating today and what is coming up next.
 */
export function DashboardPage(): JSX.Element {
  const session = useSession();
  const toasts = useToasts();
  const [running, setRunning] = useState(false);
  const data = useAsync((signal) => dashboard.get(signal), [session.user?.id]);

  const runNow = useCallback(async () => {
    setRunning(true);
    try {
      const result = await notifications.run(lagosToday());
      toasts.success(result.message);
      data.refresh();
    } catch (cause) {
      toasts.danger(cause instanceof Error ? cause.message : 'The rule could not be evaluated.');
    } finally {
      setRunning(false);
    }
  }, [data, toasts]);

  if (data.error) {
    return <ErrorPanel title="The dashboard could not load" message={data.error.message} onRetry={data.refresh} />;
  }

  const stats = data.data?.stats;
  const parish = normaliseParish(data.data?.parish);
  const rule = data.data?.rule ?? null;

  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">{parish.parishName}</span>
          <h1>
            {greeting()}, {session.user?.fullName.split(' ')[0] ?? 'there'}
          </h1>
          <p>
            {rule?.enabled
              ? `The ${rule.primaryChannel === 'whatsapp' ? 'WhatsApp' : 'SMS'} rule runs daily at ${rule.alertTime} (${rule.timezone})`
              : 'Automated birthday delivery is switched off — messages will not be sent until the rule is enabled.'}
            {data.lastUpdated ? ` · Data refreshed ${formatRelative(new Date(data.lastUpdated))}.` : ''}
          </p>
        </div>
        <div className="header-actions">
          <Button icon={<IconRefresh />} onClick={data.refresh} loading={data.isRefreshing}>
            Refresh
          </Button>
          {session.capabilities.canRunNow ? (
            <Button variant="primary" icon={<IconSparkle />} onClick={() => void runNow()} loading={running}>
              Run today's rule now
            </Button>
          ) : null}
        </div>
      </header>

      {data.isInitial ? (
        <div className="stack">
          <div className="kpi-grid">
            {Array.from({ length: 6 }, (_, index) => (
              <div className="kpi" key={index} aria-hidden="true">
                <span className="skeleton" style={{ width: 90 }} />
                <span className="skeleton" style={{ height: 34, marginTop: 12 }} />
                <span className="skeleton" style={{ width: 130, marginTop: 8 }} />
              </div>
            ))}
          </div>
          <div className="surface-card">
            <TableSkeleton caption="Loading today's birthdays" rows={4} />
          </div>
        </div>
      ) : (
        <div className="stack-lg">
          <section className="kpi-grid" aria-label="Key metrics">
            <Kpi
              caption="Today"
              icon={<IconCake />}
              value={String(stats?.todaysBirthdays ?? 0)}
              label="Birthdays to celebrate"
              foot={
                stats?.todaysBirthdays ? 'Send a greeting before the digest goes out.' : 'Nothing scheduled for today.'
              }
            />
            <Kpi
              caption="Next 7 days"
              icon={<IconClock />}
              value={String(stats?.nextSevenDays ?? 0)}
              label="Upcoming birthdays"
              foot="Plan follow-up calls and visits."
            />
            <Kpi
              caption="Directory"
              icon={<IconUsers />}
              value={String(stats?.activeMembers ?? 0)}
              label="Active members"
              foot={
                stats?.dataHealthIssues
                  ? `${pluralise(stats.dataHealthIssues, 'record')} needs attention.`
                  : 'Every active record has a phone number and consent.'
              }
              tone={stats?.dataHealthIssues ? 'warning' : undefined}
            />
            <Kpi
              caption="Last 30 days"
              icon={<IconCheck />}
              value={formatPercent(stats?.deliveryRate ?? null)}
              label="Delivery rate"
              foot="Confirmed delivered or read by the provider."
              tone="success"
            />
            <Kpi
              caption="Last 30 days"
              icon={<IconAlert />}
              value={String(stats?.failedDeliveries ?? 0)}
              label="Failed deliveries"
              foot={stats?.failedDeliveries ? 'Open the delivery log to see provider errors.' : 'No failures recorded.'}
              tone={stats?.failedDeliveries ? 'danger' : undefined}
            />
            <Kpi
              caption="Data quality"
              icon={<IconAlert />}
              value={String(stats?.dataHealthIssues ?? 0)}
              label="Records needing review"
              foot="Missing phone number or consent that still needs confirming."
              tone={stats?.dataHealthIssues ? 'warning' : undefined}
            />
          </section>

          <div className="kpi-grid">
            <Card
              title="Celebrating today"
              eyebrow={formatDate(data.data?.date ?? lagosToday())}
              action={
                <Button size="sm" variant="ghost" onClick={() => navigate('/birthdays')}>
                  View all
                </Button>
              }
              padded={false}
            >
              <BirthdayList
                items={data.data?.todaysBirthdays ?? []}
                emptyTitle="No birthdays today"
                emptyDescription="The rule will still run at its scheduled time and simply report that there is nobody to message."
              />
            </Card>

            <Card
              title="Coming up"
              eyebrow="Next 14 days"
              action={
                <Button size="sm" variant="ghost" onClick={() => navigate('/birthdays')}>
                  Full calendar
                </Button>
              }
              padded={false}
            >
              <BirthdayList
                items={data.data?.upcoming ?? []}
                emptyTitle="Nothing in the next fortnight"
                emptyDescription="Birthdays appear here as soon as they fall inside the notification window."
              />
            </Card>
          </div>

          <Card
            title="Recent delivery activity"
            description="The newest messages queued or sent by the parish rule."
            action={
              <Button size="sm" variant="ghost" onClick={() => navigate('/notifications')}>
                Open delivery log
              </Button>
            }
            padded={false}
          >
            {(data.data?.recentNotifications.length ?? 0) === 0 ? (
              <div className="card-body">
                <p className="muted">
                  No messages have been queued yet. The first run happens at {rule?.alertTime ?? '07:30'} Lagos time.
                </p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <caption className="sr-only">Recent notifications</caption>
                  <thead>
                    <tr>
                      <th scope="col">Recipient</th>
                      <th scope="col">Channel</th>
                      <th scope="col">Members</th>
                      <th scope="col">Status</th>
                      <th scope="col">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data?.recentNotifications.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.recipientName}</strong>
                          <small>{item.endpointLabel}</small>
                        </td>
                        <td>{item.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{item.memberCount}</td>
                        <td>
                          <NotificationStatusBadge status={item.status} />
                        </td>
                        <td>
                          <time dateTime={item.scheduledFor}>{formatDateTime(item.scheduledFor)}</time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="meta-strip">
            <span>
              Rule: <strong>{rule?.enabled ? 'Enabled' : 'Disabled'}</strong>
            </span>
            <span>
              Schedule: <strong>{rule ? `${rule.alertTime} ${rule.timezone}` : '—'}</strong>
            </span>
            <span>
              Lead time: <strong>{rule ? pluralise(rule.daysBefore, 'day') : '—'}</strong>
            </span>
            <span>
              Primary channel: <strong>{rule?.primaryChannel === 'whatsapp' ? 'WhatsApp' : 'SMS'}</strong>
            </span>
            <span>
              SMS fallback: <strong>{rule?.smsFallback ? 'On' : 'Off'}</strong>
            </span>
            <span>
              29 February: <strong>{rule?.feb29Policy === 'mar1' ? 'Treat as 1 March' : 'Treat as 28 February'}</strong>
            </span>
            <LastUpdated timestamp={data.lastUpdated} />
          </div>
        </div>
      )}
    </>
  );
}

function Kpi({
  caption,
  icon,
  value,
  label,
  foot,
  tone,
}: {
  caption: string;
  icon: JSX.Element;
  value: string;
  label: string;
  foot: string;
  tone?: 'success' | 'warning' | 'danger';
}): JSX.Element {
  return (
    <article className="kpi">
      <div className="kpi-top">
        <span className="eyebrow">{caption}</span>
        <span className="kpi-icon" data-tone={tone}>
          {icon}
        </span>
      </div>
      <p className="kpi-value">{value}</p>
      <p className="kpi-label">{label}</p>
      <p className="kpi-foot">{foot}</p>
    </article>
  );
}

function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Africa/Lagos' }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
