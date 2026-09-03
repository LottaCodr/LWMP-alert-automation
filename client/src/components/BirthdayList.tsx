import type { JSX, ReactNode } from 'react';
import type { UpcomingBirthdayDto } from '../api/types.js';
import { Avatar, Badge, EmptyState } from './ui.js';
import { IconCake } from './Icons.js';
import { describeDaysUntil, formatBirthday, formatPhone, initials } from '../lib/format.js';

/**
 * Birthday rows shared by the dashboard and the birthdays page.
 *
 * Phone numbers arrive masked unless the signed-in role may reveal them, and
 * the component never attempts to unmask anything client-side.
 */
export function BirthdayList({
  items,
  onSelect,
  emptyTitle = 'No birthdays in this window',
  emptyDescription = 'Nothing to celebrate yet. Widen the range or add members with a birthday on file.',
  emptyAction,
}: {
  items: UpcomingBirthdayDto[];
  onSelect?: (member: UpcomingBirthdayDto) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
}): JSX.Element {
  if (!items.length) {
    return <EmptyState icon={<IconCake />} title={emptyTitle} description={emptyDescription} action={emptyAction} />;
  }

  return (
    <div className="list-block">
      {items.map((member) => (
        <div className="list-row" key={member.id}>
          <Avatar initials={initials(member.fullName)} label={member.fullName} />
          <div>
            <strong>
              {member.fullName}
              {member.preferredName ? ` (${member.preferredName})` : ''}
            </strong>
            <small>
              {member.memberCode} · {member.ministryGroup} · {formatPhone(member.phoneMasked ?? member.phone)}
            </small>
          </div>
          <div style={{ textAlign: 'right', flex: '0 0 auto' }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>{formatBirthday(member.birthMonth, member.birthDay)}</strong>
            <small>{describeDaysUntil(member.daysUntil)}</small>
          </div>
          {member.daysUntil === 0 ? <Badge tone="success">Today</Badge> : null}
          {onSelect ? (
            <button type="button" className="text-action" onClick={() => onSelect(member)}>
              View
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
