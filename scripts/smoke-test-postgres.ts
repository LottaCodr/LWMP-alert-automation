/**
 * End-to-end regression test for the PostgreSQL runtime.
 *
 * Boots the real Express app against the in-memory PostgreSQL compatibility
 * layer (pg-mem) and drives it over HTTP with cookie + CSRF handling, so it
 * exercises the actual middleware chain, RBAC, outbox and provider webhooks.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { generateSync } from 'otplib';

const port = Number(process.env.SMOKE_PORT ?? 3999);
const base = `http://127.0.0.1:${port}`;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Generated per run; a committed literal reads like a credential to secret scanners.
const TERMII_WEBHOOK_SECRET = crypto.randomBytes(24).toString('hex');
// Generated per run for the same reason: a committed literal reads like a credential.
const TESTER_PASSWORD = `Tester${crypto.randomBytes(6).toString('hex')}Aa1!`;

const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    DATABASE_URL: 'pgmem://',
    SEED_DEMO_DATA: 'true',
    NODE_ENV: 'development',
    SCHEDULER_ENABLED: 'false',
    TERMII_WEBHOOK_SECRET,
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (chunk: Buffer) => {
  logs += chunk.toString();
});
child.stderr.on('data', (chunk: Buffer) => {
  logs += chunk.toString();
});

/** Response shapes the smoke test asserts against (mirrors the API DTOs). */
interface LoginResponse {
  user?: { role: string };
}
interface DashboardResponse {
  date?: string;
  stats?: { activeMembers: number };
}
interface SettingsResponse {
  rule?: { alertTime: string };
  providerMode?: string;
}
interface MemberResponse {
  member: { memberCode: string };
}
interface RunResponse {
  result?: { created: number; jobsProcessed: number };
}
interface NotificationItem {
  id: string;
  userId: string;
  type: string;
  channel: string;
  provider: string | null;
  providerMessageId: string | null;
  status: string;
  notificationKey?: string;
}
interface NotificationListResponse {
  items: NotificationItem[];
}
interface EndpointResponse {
  endpoint: { id: string };
  verification?: { debugCode?: string };
}
interface VerifiedEndpointResponse {
  endpoint?: { verifiedAt: string | null };
}
interface InvitationResponse {
  invitation?: { debugInviteLink?: string };
}
interface AcceptResponse {
  enrollmentRequired?: boolean;
}
interface TotpStartResponse {
  enrollment: { manualKey: string };
}
interface TotpConfirmResponse {
  recoveryCodes?: string[];
}
interface AuditResponse {
  items?: unknown[];
}
interface HealthResponse {
  ok?: boolean;
  database?: string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  csrf?: string;
  jar?: Map<string, string>;
  extraHeaders?: Record<string, string>;
}

const cookieJar = new Map<string, string>();

async function request<T extends object = Record<string, unknown>>(
  requestPath: string,
  { method = 'GET', body, csrf, jar = cookieJar, extraHeaders = {} }: RequestOptions = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (jar.size) headers.cookie = [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  if (csrf) headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${base}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : ([response.headers.get('set-cookie')].filter(Boolean) as string[]);
  for (const cookie of cookies) {
    const pair = cookie.split(';')[0];
    if (!pair) continue;
    const separator = pair.indexOf('=');
    if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const data = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, data };
}

async function expectOk<T extends object = Record<string, unknown>>(
  requestPath: string,
  options?: RequestOptions,
): Promise<T> {
  const { status, data } = await request<T>(requestPath, options);
  if (status >= 400) {
    throw new Error(`${options?.method ?? 'GET'} ${requestPath} -> ${status} ${JSON.stringify(data)}`);
  }
  return data;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function csrfFor(jar: Map<string, string> = cookieJar): Promise<string> {
  const data = await expectOk<{ csrfToken: string }>('/api/auth/csrf', { jar });
  return data.csrfToken;
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const health = await fetch(`${base}/api/health`);
      if (health.ok) return;
    } catch {
      /* still booting */
    }
    await wait(150);
  }
  throw new Error(`Test runtime did not become healthy. ${logs}`);
}

async function run(): Promise<void> {
  await waitForHealth();
  const csrf = await csrfFor();

  // Unsafe requests without a CSRF token are rejected.
  const withoutCsrf = await request('/api/notifications/test', { method: 'POST', body: {} });
  assert(withoutCsrf.status === 403, 'Unsafe request without a CSRF token should be rejected.');

  const login = await expectOk<LoginResponse>('/api/auth/login', {
    method: 'POST',
    csrf,
    body: { email: 'owner@livingwater.demo', password: 'LivingWater@2026' },
  });
  assert(login.user?.role === 'owner', 'Owner sign-in failed.');

  const dashboard = await expectOk<DashboardResponse>('/api/dashboard');
  assert(
    dashboard.stats?.activeMembers === 3,
    `Dashboard returned ${dashboard.stats?.activeMembers} members, expected 3.`,
  );

  const settings = await expectOk<SettingsResponse>('/api/settings');
  assert(settings.rule?.alertTime === '07:30', 'Notification rule DTO is not frontend-compatible.');
  assert(settings.providerMode === 'mock', 'Expected mock provider mode in the test runtime.');

  const baseMember = {
    lastName: 'Sequence',
    preferredName: null,
    birthMonth: 1,
    birthDay: 2,
    birthYear: 1990,
    status: 'active',
    ministryGroup: 'General',
    birthdayAlertAllowed: false,
    consentRecorded: true,
  };
  const created = await Promise.all([
    expectOk<MemberResponse>('/api/members', {
      method: 'POST',
      csrf,
      body: { ...baseMember, firstName: 'Atomic One', phone: '08030000031' },
    }),
    expectOk<MemberResponse>('/api/members', {
      method: 'POST',
      csrf,
      body: { ...baseMember, firstName: 'Atomic Two', phone: '08030000032' },
    }),
  ]);
  const assignedCodes = created.map((result) => result.member.memberCode).sort();
  assert(
    assignedCodes.join(',') === 'LW-1004,LW-1005',
    `Member-code allocation was not atomic: ${assignedCodes.join(',')}`,
  );

  const scheduled = await expectOk<RunResponse>('/api/notifications/run', { method: 'POST', csrf, body: {} });
  assert(scheduled.result?.created === 3, `Expected 3 queued digests, got ${scheduled.result?.created}.`);
  assert(scheduled.result?.jobsProcessed === 3, `Expected 3 processed jobs, got ${scheduled.result?.jobsProcessed}.`);

  const afterRun = await expectOk<NotificationListResponse>('/api/notifications');
  const primary = afterRun.items.find(
    (item) =>
      item.userId === 'usr_owner' &&
      item.type === 'birthday_digest' &&
      item.channel === 'whatsapp' &&
      item.provider === 'mock',
  );
  const primaryMessageId = primary?.providerMessageId;
  assert(primaryMessageId, 'Outbox delivery did not produce a delivered primary WhatsApp record.');
  assert(primary?.status === 'delivered', `Primary WhatsApp status was ${primary?.status}, expected delivered.`);

  await expectOk('/api/webhooks/whatsapp', {
    method: 'POST',
    body: { entry: [{ changes: [{ value: { statuses: [{ id: primaryMessageId, status: 'failed' }] } }] }] },
  });
  const fallbackQueued = (await expectOk<NotificationListResponse>('/api/notifications')).items.find(
    (item) =>
      item.type === 'birthday_digest' &&
      item.channel === 'sms' &&
      (item.notificationKey ?? '').includes(':sms:fallback'),
  );
  assert(fallbackQueued, 'A failed WhatsApp callback did not queue the idempotent SMS fallback.');
  assert(fallbackQueued?.status === 'queued', `SMS fallback status was ${fallbackQueued?.status}, expected queued.`);

  const retryRun = await expectOk<RunResponse>('/api/notifications/run', { method: 'POST', csrf, body: {} });
  assert(Number(retryRun.result?.jobsProcessed) >= 1, 'The outbox did not process the queued SMS fallback.');
  const fallbackDelivered = (await expectOk<NotificationListResponse>('/api/notifications')).items.find(
    (item) => item.id === fallbackQueued?.id,
  );
  assert(fallbackDelivered?.status === 'delivered', 'SMS fallback did not complete through the outbox worker path.');

  const smsDeliveryPayload = { message_id: fallbackDelivered?.providerMessageId, status: 'Delivered' };
  const termiiSignature = crypto
    .createHmac('sha512', TERMII_WEBHOOK_SECRET)
    .update(JSON.stringify(smsDeliveryPayload))
    .digest('hex');
  await expectOk('/api/webhooks/sms', {
    method: 'POST',
    body: smsDeliveryPayload,
    extraHeaders: { 'x-termii-signature': termiiSignature },
  });

  const unsignedWebhook = await request('/api/webhooks/sms', {
    method: 'POST',
    body: smsDeliveryPayload,
    extraHeaders: { 'x-termii-signature': 'deadbeef' },
  });
  assert(unsignedWebhook.status === 401, 'An unsigned Termii webhook should be rejected.');

  const endpoint = await expectOk<EndpointResponse>('/api/endpoints', {
    method: 'POST',
    csrf,
    body: { channel: 'sms', phone: '08030000017', label: 'Automated PG endpoint', priority: 3, optInConfirmed: true },
  });
  const debugCode = endpoint.verification?.debugCode;
  assert(debugCode, 'Mock endpoint verification code was not returned in test mode.');
  const verified = await expectOk<VerifiedEndpointResponse>(
    `/api/endpoints/${endpoint.endpoint.id}/verification/confirm`,
    {
      method: 'POST',
      csrf,
      body: { code: debugCode },
    },
  );
  assert(verified.endpoint?.verifiedAt, 'Endpoint verification did not persist.');

  const invitation = await expectOk<InvitationResponse>('/api/staff/invitations', {
    method: 'POST',
    csrf,
    body: {
      fullName: 'Automated PostgreSQL Tester',
      email: 'automated.pg@example.test',
      role: 'auditor',
      groupScope: [],
    },
  });
  const token = invitation.invitation?.debugInviteLink?.split('/').pop();
  assert(token, 'Mock staff invitation link was not created.');

  const inviteJar = new Map<string, string>();
  const inviteCsrf = await csrfFor(inviteJar);
  const accepted = await expectOk<AcceptResponse>(`/api/invitations/${token}/accept`, {
    method: 'POST',
    csrf: inviteCsrf,
    jar: inviteJar,
    body: { password: TESTER_PASSWORD },
  });
  assert(accepted.enrollmentRequired, 'New staff account was not forced into MFA enrollment.');

  const setup = await expectOk<TotpStartResponse>('/api/auth/mfa/totp/start', {
    method: 'POST',
    csrf: inviteCsrf,
    jar: inviteJar,
  });
  const code = generateSync({ secret: setup.enrollment.manualKey });
  const completed = await expectOk<TotpConfirmResponse>('/api/auth/mfa/totp/confirm', {
    method: 'POST',
    csrf: inviteCsrf,
    jar: inviteJar,
    body: { code },
  });
  assert(completed.recoveryCodes?.length === 10, 'TOTP setup did not issue ten recovery codes.');

  const protectedDashboard = await expectOk<DashboardResponse>('/api/dashboard', { jar: inviteJar });
  assert(protectedDashboard.date, 'New staff account did not receive access after MFA.');

  // RBAC: an Auditor may read the audit trail but never the member directory.
  const auditorMembers = await request('/api/members', { jar: inviteJar });
  assert(auditorMembers.status === 403, `Auditor member access returned ${auditorMembers.status}, expected 403.`);
  const auditTrail = await expectOk<AuditResponse>('/api/audit?limit=20', { jar: inviteJar });
  assert(Array.isArray(auditTrail.items) && auditTrail.items.length > 0, 'Audit trail was empty.');

  const health = await expectOk<HealthResponse>('/api/health');
  assert(health.ok === true && health.database === 'postgresql', 'Health endpoint did not report a healthy database.');
}

try {
  await run();
  console.log('PostgreSQL runtime smoke test passed.');
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  console.error(logs);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), wait(1500)]);
}
