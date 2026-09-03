import { useCallback, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { members } from '../../api/index.js';
import type { MemberDto, MemberStatus } from '../../api/types.js';
import { useAsync, useDebouncedValue } from '../../hooks/useAsync.js';
import { useSession } from '../../app/session.js';
import { navigate } from '../../app/router.js';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorPanel,
  LastUpdated,
  SelectInput,
  TableSkeleton,
  TextInput,
} from '../../components/ui.js';
import { Modal } from '../../components/Modal.js';
import { useToasts } from '../../components/Toasts.js';
import {
  IconArchive,
  IconClose,
  IconPlus,
  IconSearch,
  IconSort,
  IconUpload,
  IconUsers,
} from '../../components/Icons.js';
import { formatBirthday, formatPhone, formatRelative, initials, pluralise } from '../../lib/format.js';
import { describeMemberStatus, MEMBER_STATUS_OPTIONS } from '../../lib/status.js';
import { MemberModal } from './MemberModal.js';

type SortKey = 'name' | 'memberCode' | 'birthday' | 'group' | 'status' | 'updated';

interface SortState {
  key: SortKey;
  direction: 'asc' | 'desc';
}

const PAGE_SIZE = 20;

/**
 * Member directory.
 *
 * Search, status and group filters are all visible as removable chips with a
 * result count, and the empty state distinguishes "no members yet" from "no
 * members match these filters" (which offers a one-click clear).
 */
export function MembersPage(): JSX.Element {
  const session = useSession();
  const toasts = useToasts();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [group, setGroup] = useState('all');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: 'updated', direction: 'desc' });
  const [editing, setEditing] = useState<MemberDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<MemberDto | null>(null);

  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const query = { search: debouncedSearch, status, group, page, pageSize: PAGE_SIZE };
  const data = useAsync((signal) => members.list(query, signal), [debouncedSearch, status, group, page]);

  const filtered = Boolean(debouncedSearch) || status !== 'all' || group !== 'all';

  const clearFilters = useCallback(() => {
    setSearch('');
    setStatus('all');
    setGroup('all');
    setPage(1);
  }, []);

  const rows = useMemo(() => {
    const items = [...(data.data?.items ?? [])];
    const direction = sort.direction === 'asc' ? 1 : -1;
    items.sort((a, b) => direction * compare(a, b, sort.key));
    return items;
  }, [data.data, sort]);

  const totalPages = Math.max(1, Math.ceil((data.data?.total ?? 0) / PAGE_SIZE));

  const toggleSort = (key: SortKey): void => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  };

  const confirmArchive = useCallback(async () => {
    if (!archiving) return;
    try {
      const result = await members.archive(archiving.id);
      toasts.success(result.message);
      setArchiving(null);
      data.refresh();
    } catch (cause) {
      toasts.danger(cause instanceof Error ? cause.message : 'The member could not be archived.');
    }
  }, [archiving, data, toasts]);

  if (!session.capabilities.canManageMembers) {
    return (
      <ErrorPanel
        title="Not available for your role"
        message="Only organisation owners and membership officers can open the member directory. Birthday coordinators can see the upcoming birthdays assigned to their groups."
      />
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">Directory</span>
          <h1>Members</h1>
          <p>
            {data.data ? `${pluralise(data.data.total, 'record')} in the parish directory.` : 'Loading the directory…'}{' '}
            Phone numbers are masked unless your role permits viewing them.
          </p>
        </div>
        <div className="header-actions">
          <Button icon={<IconUpload />} onClick={() => navigate('/imports')}>
            Import CSV
          </Button>
          <Button variant="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
            Add member
          </Button>
        </div>
      </header>

      <section className="surface-card">
        <div className="toolbar">
          <div className="toolbar-search">
            <IconSearch />
            <TextInput
              id="member-search"
              type="search"
              placeholder="Search by name or member code"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              aria-label="Search members"
            />
          </div>
          <SelectInput
            id="member-status-filter"
            aria-label="Filter by status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            options={[{ value: 'all', label: 'All statuses' }, ...MEMBER_STATUS_OPTIONS]}
            style={{ width: 'auto', minWidth: 160 }}
          />
          <SelectInput
            id="member-group-filter"
            aria-label="Filter by ministry group"
            value={group}
            onChange={(event) => {
              setGroup(event.target.value);
              setPage(1);
            }}
            options={[
              { value: 'all', label: 'All groups' },
              ...(data.data?.groups ?? []).map((name) => ({ value: name, label: name })),
            ]}
            style={{ width: 'auto', minWidth: 180 }}
          />
          <div className="toolbar-spacer" />
          {data.isRefreshing ? <span className="muted">Updating…</span> : <LastUpdated timestamp={data.lastUpdated} />}
          <Button size="sm" variant="ghost" icon={<IconUsers />} onClick={data.refresh}>
            Refresh
          </Button>
        </div>

        {filtered ? (
          <div className="toolbar" style={{ borderTop: 0 }}>
            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Filters
            </span>
            <div className="chip-row">
              {debouncedSearch ? (
                <span className="filter-chip">
                  “{debouncedSearch}”
                  <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
                    <IconClose size={12} />
                  </button>
                </span>
              ) : null}
              {status !== 'all' ? (
                <span className="filter-chip">
                  {describeMemberStatus(status as MemberStatus).label}
                  <button type="button" onClick={() => setStatus('all')} aria-label="Clear status filter">
                    <IconClose size={12} />
                  </button>
                </span>
              ) : null}
              {group !== 'all' ? (
                <span className="filter-chip">
                  {group}
                  <button type="button" onClick={() => setGroup('all')} aria-label="Clear group filter">
                    <IconClose size={12} />
                  </button>
                </span>
              ) : null}
            </div>
            <div className="toolbar-spacer" />
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Clear all
            </Button>
          </div>
        ) : null}

        {data.error ? (
          <ErrorPanel title="The directory could not load" message={data.error.message} onRetry={data.refresh} />
        ) : data.isInitial ? (
          <TableSkeleton caption="Loading members" rows={8} />
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={<IconSearch />}
              title="No members match these filters"
              description={`${pluralise(data.data?.total ?? 0, 'record')} exist in the directory. Remove a filter to widen the search.`}
              action={<Button onClick={clearFilters}>Clear all filters</Button>}
            />
          ) : (
            <EmptyState
              icon={<IconUsers />}
              title="No members yet"
              description="Add your first member record, or bulk-load the membership list from a CSV export. Birthdays only start appearing once a record exists."
              action={
                <div className="row">
                  <Button variant="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
                    Add a member
                  </Button>
                  <Button icon={<IconUpload />} onClick={() => navigate('/imports')}>
                    Import CSV
                  </Button>
                </div>
              }
            />
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <caption>
                  Showing {rows.length} of {data.data?.total ?? 0} records · sorted by {sortLabel(sort)} for this page
                </caption>
                <thead>
                  <tr>
                    <SortHeader label="Member" sortKey="name" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Code" sortKey="memberCode" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Birthday" sortKey="birthday" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Ministry group" sortKey="group" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
                    <th scope="col">Alerts</th>
                    <SortHeader label="Updated" sortKey="updated" sort={sort} onSort={toggleSort} />
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((member) => {
                    const descriptor = describeMemberStatus(member.status);
                    return (
                      <tr key={member.id}>
                        <td>
                          <div className="row" style={{ gap: 'var(--space-3)' }}>
                            <Avatar initials={initials(member.fullName)} size="sm" label={member.fullName} />
                            <div>
                              <strong>
                                {member.fullName}
                                {member.preferredName ? ` (${member.preferredName})` : ''}
                              </strong>
                              <small>{formatPhone(member.phone ?? member.phoneMasked)}</small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                            {member.memberCode}
                          </code>
                        </td>
                        <td>
                          {formatBirthday(member.birthMonth, member.birthDay, member.birthYear)}
                          {member.birthYear ? null : <small>Birthday alerts use month and day only</small>}
                        </td>
                        <td>{member.ministryGroup}</td>
                        <td>
                          <Badge tone={descriptor.tone}>{descriptor.label}</Badge>
                        </td>
                        <td>
                          {member.birthdayAlertAllowed ? (
                            <Badge tone="success">On</Badge>
                          ) : (
                            <Badge tone="neutral">Off</Badge>
                          )}
                        </td>
                        <td>
                          <time dateTime={member.updatedAt}>{formatRelative(member.updatedAt)}</time>
                        </td>
                        <td>
                          <div className="row" style={{ gap: 'var(--space-1)', flexWrap: 'nowrap' }}>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(member)}>
                              Edit
                            </Button>
                            {member.status === 'archived' ? (
                              <Badge tone="neutral">Archived</Badge>
                            ) : (
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => setArchiving(member)}
                                aria-label={`Archive ${member.fullName}`}
                              >
                                <IconArchive size={16} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="pagination">
              <span>
                Page {data.data?.page ?? 1} of {totalPages}
              </span>
              <div className="pagination-controls">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={(data.data?.page ?? 1) <= 1}
                  onClick={() => setPage((current) => current - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={(data.data?.page ?? 1) >= totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

      <MemberModal
        open={creating || Boolean(editing)}
        member={editing}
        groups={data.data?.groups ?? []}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setCreating(false);
          setEditing(null);
          data.refresh();
        }}
      />

      <Modal
        open={Boolean(archiving)}
        title={`Archive ${archiving?.fullName ?? ''}?`}
        description="Archiving stops future birthday reminders for this person. The record is kept for membership history."
        onClose={() => setArchiving(null)}
        footer={
          <>
            <Button onClick={() => setArchiving(null)}>Keep active</Button>
            <Button variant="danger" onClick={() => void confirmArchive()}>
              Archive member
            </Button>
          </>
        }
      >
        <p className="muted" style={{ fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-relaxed)' }}>
          You can restore the record later by editing the member and setting the status back to <strong>Active</strong>.
        </p>
      </Modal>
    </>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
}): JSX.Element {
  const active = sort.key === sortKey;
  return (
    <th scope="col" aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-button" onClick={() => onSort(sortKey)}>
        {label}
        <IconSort size={13} aria-hidden="true" />
        {active ? (
          <span className="sr-only">, sorted {sort.direction === 'asc' ? 'ascending' : 'descending'}</span>
        ) : null}
      </button>
    </th>
  );
}

function sortLabel(sort: SortState): string {
  const labels: Record<SortKey, string> = {
    name: 'name',
    memberCode: 'member code',
    birthday: 'birthday',
    group: 'ministry group',
    status: 'status',
    updated: 'last update',
  };
  return `${labels[sort.key]} (${sort.direction === 'asc' ? 'A–Z' : 'Z–A'})`;
}

function compare(a: MemberDto, b: MemberDto, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.fullName.localeCompare(b.fullName);
    case 'memberCode':
      return a.memberCode.localeCompare(b.memberCode, undefined, { numeric: true });
    case 'birthday':
      return a.birthMonth - b.birthMonth || a.birthDay - b.birthDay;
    case 'group':
      return a.ministryGroup.localeCompare(b.ministryGroup);
    case 'status':
      return a.status.localeCompare(b.status);
    case 'updated':
      return a.updatedAt.localeCompare(b.updatedAt);
  }
}
