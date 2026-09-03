import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { audit } from '../../api/index.js';
import { useAsync, useDebouncedValue } from '../../hooks/useAsync.js';
import { useSession } from '../../app/session.js';
import {
  Button,
  EmptyState,
  ErrorPanel,
  LastUpdated,
  SelectInput,
  TableSkeleton,
  TextInput,
} from '../../components/ui.js';
import { IconRefresh, IconSearch, IconShield } from '../../components/Icons.js';
import { formatDateTime, formatRelative, titleCase } from '../../lib/format.js';

/**
 * Immutable audit trail.
 *
 * Read-only by design: the log is the evidence, so the UI offers filtering and
 * nothing else. Auditors can reach this page even though they cannot see the
 * member directory.
 */
export function AuditPage(): JSX.Element {
  const session = useSession();
  const [limit, setLimit] = useState(80);
  const [action, setAction] = useState('all');
  const [actor, setActor] = useState('');
  const debouncedActor = useDebouncedValue(actor.trim().toLowerCase(), 250);

  const data = useAsync(
    (signal) => audit.list(limit, signal).then((result) => result.items),
    [limit, session.user?.id],
  );

  const actions = useMemo(() => {
    const unique = new Set((data.data ?? []).map((item) => item.action));
    return [...unique].sort();
  }, [data.data]);

  const rows = useMemo(
    () =>
      (data.data ?? []).filter(
        (item) =>
          (action === 'all' || item.action === action) &&
          (!debouncedActor || item.actorName.toLowerCase().includes(debouncedActor)),
      ),
    [data.data, action, debouncedActor],
  );

  if (!session.capabilities.canSeeAudit) {
    return (
      <ErrorPanel
        title="Not available for your role"
        message="The audit trail is available to organisation owners and auditors only."
      />
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">Compliance</span>
          <h1>Audit trail</h1>
          <p>
            Every privileged action recorded with who performed it and when. This log is append-only and cannot be
            edited from the dashboard.
          </p>
        </div>
        <div className="header-actions">
          <SelectInput
            id="audit-limit"
            aria-label="Number of entries"
            value={String(limit)}
            onChange={(event) => setLimit(Number(event.target.value))}
            options={[
              { value: '25', label: 'Last 25' },
              { value: '80', label: 'Last 80' },
              { value: '150', label: 'Last 150' },
            ]}
            style={{ width: 'auto', minWidth: 140 }}
          />
          <Button icon={<IconRefresh />} onClick={data.refresh} loading={data.isRefreshing}>
            Refresh
          </Button>
        </div>
      </header>

      <section className="surface-card">
        <div className="toolbar">
          <div className="toolbar-search">
            <IconSearch />
            <TextInput
              id="audit-actor"
              type="search"
              placeholder="Filter by person"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              aria-label="Filter audit entries by person"
            />
          </div>
          <SelectInput
            id="audit-action"
            aria-label="Filter by action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            options={[
              { value: 'all', label: 'All actions' },
              ...actions.map((value) => ({ value, label: titleCase(value) })),
            ]}
            style={{ width: 'auto', minWidth: 220 }}
          />
          <div className="toolbar-spacer" />
          <span className="muted">{rows.length} entries</span>
          <LastUpdated timestamp={data.lastUpdated} />
        </div>

        {data.error ? (
          <ErrorPanel title="The audit trail could not load" message={data.error.message} onRetry={data.refresh} />
        ) : data.isInitial ? (
          <TableSkeleton caption="Loading audit trail" rows={10} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconShield />}
            title={data.data?.length ? 'No entries match these filters' : 'No activity recorded yet'}
            description={
              data.data?.length
                ? 'Try a different action or clear the name filter.'
                : 'Sign-ins, member changes, rule updates and delivery events will appear here.'
            }
            action={
              data.data?.length ? (
                <Button
                  onClick={() => {
                    setAction('all');
                    setActor('');
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption>Newest first · up to {limit} entries</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Person</th>
                  <th scope="col">Action</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                      <small>{formatRelative(item.createdAt)}</small>
                    </td>
                    <td>{item.actorName}</td>
                    <td>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{item.action}</code>
                    </td>
                    <td>
                      {item.entityType}
                      {item.entityId ? <small>{item.entityId}</small> : null}
                    </td>
                    <td>{item.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
