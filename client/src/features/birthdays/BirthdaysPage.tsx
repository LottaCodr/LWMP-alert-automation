import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { birthdays } from '../../api/index.js';
import type { UpcomingBirthdayDto } from '../../api/types.js';
import { useAsync } from '../../hooks/useAsync.js';
import { useSession } from '../../app/session.js';
import { Button, EmptyState, ErrorPanel, LastUpdated } from '../../components/ui.js';
import { BirthdayList } from '../../components/BirthdayList.js';
import { IconCake, IconRefresh } from '../../components/Icons.js';
import { formatDate, pluralise } from '../../lib/format.js';

const RANGES = [
  { value: 0, label: 'Today' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
];

/**
 * Birthday pipeline.
 *
 * Grouped by the day the greeting is due so a coordinator can work the list top
 * to bottom. The window matches the rule's lead time where possible, and the
 * count for each day makes the workload obvious at a glance.
 */
export function BirthdaysPage(): JSX.Element {
  const session = useSession();
  const [days, setDays] = useState(30);

  const data = useAsync(
    () => (days === 0 ? birthdays.today() : birthdays.upcoming(days)).then((result) => result.items),
    [days, session.user?.id],
    { enabled: session.capabilities.canSeeBirthdays },
  );

  const groups = useMemo(() => {
    const map = new Map<string, UpcomingBirthdayDto[]>();
    for (const item of data.data ?? []) {
      const key = item.occurrenceDate;
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data.data]);

  if (!session.capabilities.canSeeBirthdays) {
    return (
      <ErrorPanel
        title="Not available for your role"
        message="Birthday lists are available to owners, membership officers and birthday coordinators."
      />
    );
  }

  const total = data.data?.length ?? 0;

  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">Outreach</span>
          <h1>Birthdays</h1>
          <p>
            {data.data
              ? `${pluralise(total, 'birthday')} in the selected window. Coordinators only see the ministry groups assigned to them.`
              : 'Loading upcoming birthdays…'}
          </p>
        </div>
        <div className="header-actions">
          <div className="segmented" role="group" aria-label="Time range">
            {RANGES.map((range) => (
              <button
                key={range.value}
                type="button"
                aria-pressed={days === range.value}
                onClick={() => setDays(range.value)}
              >
                {range.label}
              </button>
            ))}
          </div>
          <Button icon={<IconRefresh />} onClick={data.refresh} loading={data.isRefreshing}>
            Refresh
          </Button>
        </div>
      </header>

      {data.error ? (
        <ErrorPanel title="Birthdays could not load" message={data.error.message} onRetry={data.refresh} />
      ) : (
        <div className="stack">
          <div className="meta-strip">
            <span>
              Window: <strong>{days === 0 ? 'Today' : pluralise(days, 'day')}</strong>
            </span>
            <span>
              Total: <strong>{pluralise(total, 'birthday')}</strong>
            </span>
            <span>
              Days covered: <strong>{groups.length}</strong>
            </span>
            <LastUpdated timestamp={data.lastUpdated} />
          </div>

          {data.isInitial ? (
            <section className="surface-card">
              <div className="loading-stack" role="status" aria-busy="true">
                <span className="sr-only">Loading birthdays</span>
                <span className="skeleton skeleton-title" />
                {Array.from({ length: 5 }, (_, index) => (
                  <span key={index} className="skeleton skeleton-row" />
                ))}
              </div>
            </section>
          ) : !groups.length ? (
            <section className="surface-card">
              <EmptyState
                icon={<IconCake />}
                title={days === 0 ? 'No birthdays today' : 'No birthdays in this window'}
                description="Either nobody has a birthday in this range, or the members in scope have reminders switched off. Widen the range to check."
                action={days !== 90 ? <Button onClick={() => setDays(90)}>Show the next 90 days</Button> : undefined}
              />
            </section>
          ) : (
            groups.map(([date, items]) => (
              <section className="surface-card" key={date}>
                <div className="card-heading">
                  <div>
                    <span className="eyebrow">
                      {items[0]?.daysUntil === 0 ? 'Today' : `In ${items[0]?.daysUntil} days`}
                    </span>
                    <h2>{formatDate(date)}</h2>
                  </div>
                  <span className="badge badge-neutral">{pluralise(items.length, 'person', 'people')}</span>
                </div>
                <BirthdayList items={items} />
              </section>
            ))
          )}
        </div>
      )}
    </>
  );
}
