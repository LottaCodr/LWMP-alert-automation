/**
 * Typed wrappers for every endpoint the SPA consumes.
 * Keeping them in one module means a route rename is a compile error here,
 * not a 404 discovered in production.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { get, patch, post, put } from './client.js';
import type {
  AuditEventDto,
  DashboardDto,
  DemoAccount,
  EndpointDto,
  EndpointPayload,
  EndpointVerificationDto,
  HealthDto,
  ImportCommitResult,
  ImportPreviewDto,
  ImportRowDto,
  InvitationDto,
  MfaMethods,
  MfaStatusDto,
  MemberDto,
  MemberListResult,
  MemberPayload,
  NotificationDto,
  NotificationRuleDto,
  ParishProfile,
  PublicInvitationDto,
  RulePayload,
  SafeUser,
  StaffAccessDto,
  StaffInvitationPayload,
  StaffListItem,
  TotpEnrollmentDto,
  UpcomingBirthdayDto,
} from './types.js';

export * from './types.js';
export { ApiError, API_BASE_URL, SESSION_EXPIRED_EVENT, clearCsrfToken } from './client.js';

/* ------------------------------------------------------------------ *
 * Authentication & multi-factor
 * ------------------------------------------------------------------ */

export interface LoginResponse {
  user?: SafeUser;
  requiresMfa?: boolean;
  enrollmentRequired?: boolean;
  methods?: MfaMethods;
  demoMode?: boolean;
}

export const auth = {
  demoAccounts: () => get<{ password: string; accounts: DemoAccount[] }>('/api/auth/demo-accounts'),
  login: (email: string, password: string) => post<LoginResponse>('/api/auth/login', { email, password }),
  logout: () => post<void>('/api/auth/logout'),
  me: () => get<{ user: SafeUser; roleLabel: string; demoMode: boolean }>('/api/auth/me'),
  mfaStatus: () => get<MfaStatusDto>('/api/auth/mfa/status'),
  startTotpEnrollment: () => post<{ enrollment: TotpEnrollmentDto }>('/api/auth/mfa/totp/start'),
  confirmTotpEnrollment: (code: string) =>
    post<{ user: SafeUser; recoveryCodes: string[]; message: string }>('/api/auth/mfa/totp/confirm', { code }),
  verify: (method: 'totp' | 'recovery', code: string) =>
    post<{ user: SafeUser; demoMode: boolean }>('/api/auth/mfa/verify', { method, code }),
  recoveryCodes: (code: string) =>
    post<{ recoveryCodes: string[]; message: string }>('/api/auth/mfa/recovery-codes', { code }),

  passkeyOptions: (email: string) =>
    post<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/passkey/options', { email }),
  passkeyVerify: (response: AuthenticationResponseJSON) =>
    post<{ user: SafeUser; demoMode: boolean }>('/api/auth/passkey/verify', { response }),
  mfaPasskeyOptions: () => post<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/mfa/passkey/options'),
  mfaPasskeyVerify: (response: AuthenticationResponseJSON) =>
    post<{ user: SafeUser; demoMode: boolean }>('/api/auth/mfa/passkey/verify', { response }),
  passkeyRegistrationOptions: () =>
    post<{ options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/passkeys/registration/options'),
  passkeyRegistrationVerify: (response: RegistrationResponseJSON) =>
    post<{ user: SafeUser; message: string }>('/api/auth/passkeys/registration/verify', { response }),
};

/* The WebAuthn ceremony types come straight from the browser SDK so the
 * client and `@simplewebauthn/server` on the API cannot drift apart. */
export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

export const dashboard = {
  get: (signal?: AbortSignal) => get<DashboardDto>('/api/dashboard', signal),
};

/* ------------------------------------------------------------------ *
 * Members
 * ------------------------------------------------------------------ */

export interface MemberQuery {
  search?: string;
  status?: string;
  group?: string;
  page?: number;
  pageSize?: number;
}

function memberQueryString(query: MemberQuery): string {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.status && query.status !== 'all') params.set('status', query.status);
  if (query.group && query.group !== 'all') params.set('group', query.group);
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 20));
  return params.toString();
}

export const members = {
  list: (query: MemberQuery = {}, signal?: AbortSignal) =>
    get<MemberListResult>(`/api/members?${memberQueryString(query)}`, signal),
  get: (id: string) => get<{ member: MemberDto }>(`/api/members/${encodeURIComponent(id)}`),
  create: (payload: MemberPayload) => post<{ member: MemberDto; message: string }>('/api/members', payload),
  update: (id: string, payload: MemberPayload) =>
    patch<{ member: MemberDto; message: string }>(`/api/members/${encodeURIComponent(id)}`, payload),
  archive: (id: string) => post<{ message: string }>(`/api/members/${encodeURIComponent(id)}/archive`),
};

/* ------------------------------------------------------------------ *
 * Birthdays
 * ------------------------------------------------------------------ */

export const birthdays = {
  today: () => get<{ date: string; items: UpcomingBirthdayDto[] }>('/api/birthdays/today'),
  upcoming: (days: number) =>
    get<{ items: UpcomingBirthdayDto[]; days: number }>(`/api/birthdays/upcoming?days=${days}`),
};

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

export const notifications = {
  list: (limit = 40, signal?: AbortSignal) =>
    get<{ items: NotificationDto[] }>(`/api/notifications?limit=${limit}`, signal),
  test: () => post<{ result: { channel: string; mode: string }; message: string }>('/api/notifications/test'),
  run: (date?: string) =>
    post<{
      result: { date: string; created: number; skipped: number; jobsProcessed?: number; disabled?: boolean };
      message: string;
    }>('/api/notifications/run', date ? { date } : {}),
};

/* ------------------------------------------------------------------ *
 * Settings & endpoints
 * ------------------------------------------------------------------ */

export interface SettingsDto {
  rule: NotificationRuleDto | null;
  canManageRule: boolean;
  endpoints: EndpointDto[];
  providerMode: string;
}

export const settings = {
  get: () => get<SettingsDto>('/api/settings'),
  updateRule: (payload: RulePayload) => put<{ rule: NotificationRuleDto }>('/api/settings/rule', payload),
};

export const endpoints = {
  create: (payload: EndpointPayload) =>
    post<{ endpoint: EndpointDto; verification: EndpointVerificationDto; message: string }>('/api/endpoints', payload),
  resendVerification: (id: string) =>
    post<{ verification: EndpointVerificationDto; message: string }>(
      `/api/endpoints/${encodeURIComponent(id)}/verification/resend`,
    ),
  confirmVerification: (id: string, code: string) =>
    post<{ endpoint: EndpointDto; message: string }>(`/api/endpoints/${encodeURIComponent(id)}/verification/confirm`, {
      code,
    }),
  update: (id: string, payload: { enabled?: boolean; priority?: number }) =>
    patch<{ endpoint: EndpointDto }>(`/api/endpoints/${encodeURIComponent(id)}`, payload),
};

/* ------------------------------------------------------------------ *
 * Staff, invitations and audit
 * ------------------------------------------------------------------ */

export const staff = {
  access: () => get<StaffAccessDto>('/api/staff/access'),
  invite: (payload: StaffInvitationPayload) =>
    post<InvitationDto & { delivery: { status: string }; message: string }>('/api/staff/invitations', payload),
  revokeInvitation: (id: string) => post<void>(`/api/staff/invitations/${encodeURIComponent(id)}/revoke`),
  deactivate: (id: string) => post<void>(`/api/staff/${encodeURIComponent(id)}/deactivate`),
};

export const invitations = {
  get: (token: string) => get<{ invitation: PublicInvitationDto }>(`/api/invitations/${encodeURIComponent(token)}`),
  accept: (token: string, password: string) =>
    post<{ user: SafeUser; requiresMfa: boolean; enrollmentRequired: boolean; methods: MfaMethods; message: string }>(
      `/api/invitations/${encodeURIComponent(token)}/accept`,
      { password },
    ),
};

export const audit = {
  list: (limit = 80, signal?: AbortSignal) =>
    get<{ items: AuditEventDto[]; limit: number }>(`/api/audit?limit=${limit}`, signal),
};

export const imports = {
  preview: (csvText: string) => post<ImportPreviewDto>('/api/imports/preview', { csvText }),
  commit: (rows: ImportRowDto[]) => post<ImportCommitResult>('/api/imports/commit', { rows }),
};

export const health = {
  readiness: () => get<HealthDto>('/api/health'),
};

/* ------------------------------------------------------------------ *
 * Shared vocabulary reused by the UI
 * ------------------------------------------------------------------ */

export interface ParishSettings {
  parishName: string;
  environment: string;
}

export function normaliseParish(parish: ParishProfile | undefined | null): ParishSettings {
  const name =
    typeof parish?.parishName === 'string' && parish.parishName ? parish.parishName : 'Living Water Mega Parish – RCCG';
  const environment = typeof parish?.environment === 'string' && parish.environment ? parish.environment : 'demo';
  return { parishName: name, environment };
}

export function roleLabel(role: StaffListItem['role']): string {
  const labels: Record<StaffListItem['role'], string> = {
    owner: 'Organisation Owner',
    membership_officer: 'Membership Officer',
    birthday_coordinator: 'Birthday Coordinator',
    auditor: 'Auditor',
  };
  return labels[role];
}
