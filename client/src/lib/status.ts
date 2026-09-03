/** Shared vocabulary maps: notification statuses, member statuses, permissions. */
import type { MemberStatus, NotificationStatus, UserRole } from '../api/types.js';

export type Tone = 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'accent';

export interface StatusDescriptor {
  label: string;
  tone: Tone;
  /** One-line explanation shown in tooltips/expandable rows. */
  description: string;
}

const NOTIFICATION_STATUSES: Record<NotificationStatus, StatusDescriptor> = {
  scheduled: {
    label: 'Scheduled',
    tone: 'info',
    description: 'Queued by the parish rule; not handed to a provider yet.',
  },
  queued: { label: 'Queued', tone: 'info', description: 'Waiting for the delivery worker to pick it up.' },
  provider_accepted: {
    label: 'Accepted',
    tone: 'info',
    description: 'The messaging provider accepted the message for delivery.',
  },
  sent: { label: 'Sent', tone: 'accent', description: 'Sent to the carrier; delivery receipt pending.' },
  delivered: { label: 'Delivered', tone: 'success', description: 'Confirmed delivered to the recipient device.' },
  read: { label: 'Read', tone: 'success', description: 'The recipient opened the message.' },
  retrying: {
    label: 'Retrying',
    tone: 'warning',
    description: 'A delivery attempt failed; another attempt is queued.',
  },
  failed: { label: 'Failed', tone: 'danger', description: 'Delivery failed. Check the endpoint and provider error.' },
  dead_letter: {
    label: 'Dead letter',
    tone: 'danger',
    description: 'All retries were exhausted. Manual follow-up is required.',
  },
};

export function describeNotificationStatus(status: NotificationStatus): StatusDescriptor {
  return NOTIFICATION_STATUSES[status] ?? { label: status, tone: 'neutral', description: '' };
}

const MEMBER_STATUSES: Record<MemberStatus, StatusDescriptor> = {
  active: { label: 'Active', tone: 'success', description: 'Eligible for birthday reminders.' },
  visitor: { label: 'Visitor', tone: 'info', description: 'First-time visitor; follow-up recommended.' },
  inactive: { label: 'Inactive', tone: 'warning', description: 'No reminders until the record is reactivated.' },
  archived: {
    label: 'Archived',
    tone: 'neutral',
    description: 'Reminders suppressed; the record is retained for history.',
  },
  deceased: { label: 'Bereaved', tone: 'neutral', description: 'Reminders suppressed permanently out of respect.' },
};

export function describeMemberStatus(status: MemberStatus): StatusDescriptor {
  return MEMBER_STATUSES[status] ?? { label: status, tone: 'neutral', description: '' };
}

export const MEMBER_STATUS_OPTIONS: Array<{ value: MemberStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'visitor', label: 'Visitor' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'archived', label: 'Archived' },
  { value: 'deceased', label: 'Bereaved' },
];

/* ------------------------------------------------------------------ *
 * Role capabilities (mirrors `server/http/guards.ts`)
 * ------------------------------------------------------------------ */

export interface Capabilities {
  canManageMembers: boolean;
  canImportMembers: boolean;
  canSeeBirthdays: boolean;
  canSeePhoneNumbers: boolean;
  canManageRule: boolean;
  canRunNow: boolean;
  canManageStaff: boolean;
  canSeeAudit: boolean;
  canSeeNotifications: boolean;
}

export function capabilitiesFor(role: UserRole | undefined | null): Capabilities {
  const is = (...roles: UserRole[]): boolean => Boolean(role && roles.includes(role));
  return {
    canManageMembers: is('owner', 'membership_officer'),
    canImportMembers: is('owner', 'membership_officer'),
    canSeeBirthdays: is('owner', 'membership_officer', 'birthday_coordinator'),
    canSeePhoneNumbers: is('owner', 'membership_officer'),
    canManageRule: is('owner'),
    canRunNow: is('owner'),
    canManageStaff: is('owner'),
    canSeeAudit: is('owner', 'auditor'),
    canSeeNotifications: true,
  };
}

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Organisation Owner',
  membership_officer: 'Membership Officer',
  birthday_coordinator: 'Birthday Coordinator',
  auditor: 'Auditor',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  owner: 'Full control: staff, rules, members, delivery and audit.',
  membership_officer: 'Maintains member records and can see full phone numbers.',
  birthday_coordinator: 'Sees upcoming birthdays for their assigned groups only.',
  auditor: 'Read-only access to the audit trail and delivery history.',
};
