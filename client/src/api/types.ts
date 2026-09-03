/**
 * Client-side mirror of the server's API DTOs (`server/types.ts`).
 *
 * These are hand-mirrored rather than imported from `server/` because the
 * server package is compiled with `NodeNext` module resolution and the client
 * with `bundler`; keeping an explicit contract here means a server change that
 * breaks the client shows up as a client type error instead of a runtime bug.
 */

export type UserRole = 'owner' | 'membership_officer' | 'birthday_coordinator' | 'auditor';
export type DeliveryChannel = 'whatsapp' | 'sms';
export type MemberStatus = 'active' | 'visitor' | 'inactive' | 'archived' | 'deceased';
export type Feb29Policy = 'feb28' | 'mar1';
export type NotificationType = 'birthday_digest' | 'test' | 'endpoint_verification';
export type NotificationStatus =
  'scheduled' | 'queued' | 'provider_accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'retrying' | 'dead_letter';
export type InvitationState = 'pending' | 'accepted' | 'expired' | 'revoked';

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
  digestMode: 'daily_digest';
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

export interface ParishProfile {
  parishName?: string;
  environment?: string;
  [key: string]: unknown;
}

export interface DashboardDto {
  date: string;
  parish: ParishProfile;
  rule: NotificationRuleDto | null;
  stats: DashboardStats;
  todaysBirthdays: UpcomingBirthdayDto[];
  upcoming: UpcomingBirthdayDto[];
  recentNotifications: NotificationDto[];
}

export interface MemberListResult {
  items: MemberDto[];
  total: number;
  page: number;
  pageSize: number;
  groups: string[];
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

export interface ImportPreviewDto {
  rows: ImportRowDto[];
  summary: { total: number; ready: number; invalid: number; duplicates: number };
}

export interface ImportCommitResult {
  imported: number;
  rejected: Array<{ rowNumber: number | undefined; reason: string }>;
  message: string;
}

export interface MfaMethods {
  totp: boolean;
  passkey: boolean;
  required: boolean;
}

export interface MfaStatusDto {
  required: boolean;
  totpEnrolled: boolean;
  passkeyEnrolled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
  preMfaChallenge: boolean;
}

export interface TotpEnrollmentDto {
  qrCodeDataUrl: string;
  manualKey: string;
  issuer: string;
  expiresAt: string;
}

export interface EndpointVerificationDto {
  expiresAt: string;
  deliveryMode: string;
  debugCode?: string;
}

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

export interface StaffListItem extends SafeUser {
  roleLabel: string;
  mfa: MfaMethods;
  createdAt: string;
}

export interface StaffAccessDto {
  users: StaffListItem[];
  invitations: InvitationDto[];
}

export interface PublicInvitationDto {
  parishName: string;
  fullName: string;
  emailMasked: string;
  role: UserRole;
  groupScope: string[];
  expiresAt: string;
}

export interface DemoAccount {
  name: string;
  email: string;
  role: UserRole;
  roleLabel: string;
}

export interface BirthdayRunResult {
  date: string;
  birthdayDate?: string;
  leadDays?: number;
  matchingMembers?: number;
  created: number;
  skipped: number;
  disabled?: boolean;
  jobsProcessed?: number;
  results: Array<{ userId: string; channel?: DeliveryChannel; notificationId?: string; status: string }>;
}

/* --- Request payloads --------------------------------------------- */

export interface MemberPayload {
  firstName: string;
  lastName: string;
  preferredName: string | null;
  phone: string;
  birthMonth: number;
  birthDay: number;
  birthYear: number | null;
  status: MemberStatus;
  ministryGroup: string;
  birthdayAlertAllowed: boolean;
  consentRecorded: boolean;
  confirmPotentialDuplicate?: boolean;
}

export interface EndpointPayload {
  channel: DeliveryChannel;
  phone: string;
  label: string;
  priority: number;
  optInConfirmed: true;
}

export interface RulePayload {
  enabled: boolean;
  digestMode: 'daily_digest';
  alertTime: string;
  daysBefore: number;
  primaryChannel: DeliveryChannel;
  smsFallback: boolean;
  feb29Policy: Feb29Policy;
}

export interface StaffInvitationPayload {
  fullName: string;
  email: string;
  role: UserRole;
  groupScope: string[];
}

export interface HealthDto {
  ok: boolean;
  database?: string;
  mode?: string;
  scheduler?: boolean;
  time: string;
}
