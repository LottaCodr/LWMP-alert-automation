import type { Request } from 'express';
import 'express-session';

/* ------------------------------------------------------------------ *
 * Domain vocabulary
 * ------------------------------------------------------------------ */

export type UserRole = 'owner' | 'membership_officer' | 'birthday_coordinator' | 'auditor';
export type DeliveryChannel = 'whatsapp' | 'sms';
export type MemberStatus = 'active' | 'visitor' | 'inactive' | 'archived' | 'deceased';
export type Feb29Policy = 'feb28' | 'mar1';
export type DigestMode = 'daily_digest';
export type NotificationType = 'birthday_digest' | 'test' | 'endpoint_verification';
export type NotificationStatus =
  'scheduled' | 'queued' | 'provider_accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'retrying' | 'dead_letter';

export const USER_ROLES: readonly UserRole[] = ['owner', 'membership_officer', 'birthday_coordinator', 'auditor'];
export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ['whatsapp', 'sms'];
export const MEMBER_STATUSES: readonly MemberStatus[] = ['active', 'visitor', 'inactive', 'archived', 'deceased'];

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Organisation Owner',
  membership_officer: 'Membership Officer',
  birthday_coordinator: 'Birthday Coordinator',
  auditor: 'Auditor',
};

/** Calendar date without a time component or timezone offset. */
export interface DateParts {
  year: number;
  month: number;
  day: number;
}

/* ------------------------------------------------------------------ *
 * Database rows (snake_case, as stored)
 * ------------------------------------------------------------------ */

export interface UserRow {
  id: string;
  full_name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  group_scope: string;
  mfa_state: string | null;
  mfa_required: boolean;
  mfa_enrolled_at: string | null;
  mfa_secret_encrypted: string | null;
  mfa_pending_secret_encrypted: string | null;
  mfa_pending_at: string | null;
  passkey_enrolled_at: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MemberRow {
  id: string;
  member_code: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  phone_encrypted: string | null;
  phone_hash: string | null;
  birth_month: number;
  birth_day: number;
  birth_year: number | null;
  status: MemberStatus;
  ministry_group: string;
  birthday_alert_allowed: boolean;
  consent_status: string | null;
  consent_at: string | null;
  privacy_notice_version: string | null;
  archived_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface AdminEndpointRow {
  id: string;
  user_id: string;
  channel: DeliveryChannel;
  phone_encrypted: string | null;
  phone_hash: string | null;
  label: string;
  priority: number;
  enabled: boolean;
  verified_at: string | null;
  opted_in_at: string | null;
  opted_out_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  notification_key: string;
  user_id: string;
  endpoint_id: string;
  channel: DeliveryChannel;
  notification_type: NotificationType;
  scheduled_for: string;
  message_preview: string;
  member_count: number;
  status: NotificationStatus;
  provider: string | null;
  provider_message_id: string | null;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  last_event_at: string | null;
}

export interface NotificationRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  digest_mode: DigestMode;
  alert_time: string;
  timezone: string;
  days_before: number;
  primary_channel: DeliveryChannel;
  sms_fallback: boolean;
  feb29_policy: Feb29Policy;
  updated_at: string;
  updated_by: string | null;
}

export interface OutboxJobRow {
  id: string;
  job_type: string;
  payload: string | null;
  due_at: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StaffInvitationRow {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  group_scope: string;
  token_hash: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
  last_sent_at: string | null;
  delivery_provider: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: boolean | null;
  last_used_at: string | null;
  created_at: string;
}

export interface EndpointVerificationRow {
  id: string;
  endpoint_id: string;
  code_hash: string | null;
  purpose: string;
  delivery_channel: DeliveryChannel;
  provider: string | null;
  provider_message_id: string | null;
  requested_at: string;
  expires_at: string;
  attempts: number;
  consumed_at: string | null;
}

export interface AuditEventRow {
  id: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  metadata: string | null;
  created_at: string;
}

export interface RecoveryCodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: string | null;
  created_at: string;
}

export interface AppSettingRow {
  setting_key: string;
  setting_value: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** A row joined with a recipient/endpoint projection, as returned by notification queries. */
export interface NotificationWithRecipientRow extends NotificationRow {
  recipient_name: string | null;
  endpoint_label: string | null;
  phone_encrypted: string | null;
}

export interface CountRow {
  count: number;
}

/* ------------------------------------------------------------------ *
 * API DTOs (camelCase, safe to serialise to the browser)
 * ------------------------------------------------------------------ */

export interface SafeUser {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  groupScope: string[];
  mfaState: string | null;
  mfaRequired: boolean;
  mfaEnrolledAt: string | null;
  passkeyEnrolledAt: string | null;
  active: boolean;
}

export interface MemberDto {
  id: string;
  memberCode: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  fullName: string;
  /** Full E.164 number for privileged roles, otherwise a masked value. */
  phone: string | null;
  phoneMasked: string | null;
  birthMonth: number;
  birthDay: number;
  birthYear: number | null;
  status: MemberStatus;
  ministryGroup: string;
  birthdayAlertAllowed: boolean;
  consentStatus: string | null;
  consentAt: string | null;
  privacyNoticeVersion: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface UpcomingBirthdayDto extends MemberDto {
  occurrenceDate: string;
  daysUntil: number;
}

export interface EndpointDto {
  id: string;
  userId: string;
  channel: DeliveryChannel;
  label: string;
  phone: string | null;
  phoneMasked: string | null;
  priority: number;
  enabled: boolean;
  verifiedAt: string | null;
  verificationRequired: boolean;
  optedInAt: string | null;
  optedOutAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDto {
  id: string;
  notificationKey: string;
  userId: string;
  recipientName: string;
  endpointLabel: string;
  endpointMasked: string | null;
  channel: DeliveryChannel;
  type: NotificationType;
  scheduledFor: string;
  messagePreview: string;
  memberCount: number;
  status: NotificationStatus;
  provider: string | null;
  providerMessageId: string | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  lastEventAt: string | null;
}

export interface NotificationRuleDto {
  id: string;
  name: string;
  enabled: boolean;
  digestMode: DigestMode;
  alertTime: string;
  timezone: string;
  daysBefore: number;
  primaryChannel: DeliveryChannel;
  smsFallback: boolean;
  feb29Policy: Feb29Policy;
  updatedAt: string;
}

export interface DashboardStats {
  activeMembers: number;
  todaysBirthdays: number;
  nextSevenDays: number;
  deliveryRate: number | null;
  failedDeliveries: number;
  dataHealthIssues: number;
}

export interface DashboardDto {
  date: string;
  parish: Record<string, unknown>;
  rule: NotificationRuleDto | null;
  stats: DashboardStats;
  todaysBirthdays: UpcomingBirthdayDto[];
  upcoming: UpcomingBirthdayDto[];
  recentNotifications: NotificationDto[];
}

export interface MfaStatusDto {
  required: boolean;
  totpEnrolled: boolean;
  passkeyEnrolled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
}

export interface MfaMethods {
  totp: boolean;
  passkey: boolean;
  required: boolean;
}

export interface TotpEnrollmentDto {
  qrCodeDataUrl: string;
  manualKey: string;
  issuer: string;
  expiresAt: string;
}

export type InvitationState = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface InvitationDto {
  id: string;
  fullName: string;
  emailMasked: string;
  role: UserRole;
  groupScope: string[];
  state: InvitationState;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  lastSentAt: string | null;
  deliveryProvider: string | null;
  deliveryStatus: string | null;
  debugInviteLink?: string;
}

export interface PublicInvitationDto {
  parishName: string;
  fullName: string;
  emailMasked: string;
  role: UserRole;
  groupScope: string[];
  expiresAt: string;
}

export interface StaffListItem extends SafeUser {
  roleLabel: string;
  mfa: MfaMethods;
  createdAt: string;
}

export interface StaffAccessDto {
  users: StaffListItem[];
  invitations: InvitationDto[];
}

export interface ImportRowDto {
  rowNumber: number;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  phone: string | null;
  birthMonth: number | null;
  birthDay: number | null;
  birthYear: number | null;
  ministryGroup: string;
  status: MemberStatus;
  birthdayAlertAllowed: boolean;
  valid: boolean;
  errors: string[];
  duplicate: { memberCode: string; fullName: string } | null;
}

export interface AuditEventDto {
  id: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  createdAt: string;
}

export interface EndpointVerificationDto {
  expiresAt: string;
  deliveryMode: string;
  debugCode?: string;
}

export interface DeliveryOutcome {
  provider: string;
  providerMessageId: string | null;
  status: string;
  deliveredAt?: string;
  providerManaged?: boolean;
  error?: string;
}

export interface BirthdayRunResult {
  date: string;
  birthdayDate?: string;
  leadDays?: number;
  matchingMembers?: number;
  created: number;
  skipped: number;
  disabled?: boolean;
  results: Array<{ userId: string; channel?: DeliveryChannel; notificationId?: string; status: string }>;
}

/* ------------------------------------------------------------------ *
 * Request/session augmentation
 * ------------------------------------------------------------------ */

export interface PasskeyCeremony {
  challenge: string;
  userId: string;
  origin: string;
  rpID: string;
  expiresAt: string;
}

export interface AuthenticatedRequest extends Request {
  rawBody?: Buffer;
  user?: SafeUser & { _row?: UserRow };
}

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    userId?: string;
    authenticatedAt?: string;
    mfaSatisfiedAt?: string;
    preMfaUserId?: string;
    preMfaStartedAt?: string;
    passkeyAuthentication?: PasskeyCeremony;
    passkeyMfaAuthentication?: PasskeyCeremony;
    passkeyRegistration?: PasskeyCeremony;
  }
}

declare global {
  // `namespace Express` is the documented Express 5 module-augmentation shape;
  // there is no ES-module equivalent for extending a global namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      user?: SafeUser & { _row?: UserRow };
    }
  }
}
