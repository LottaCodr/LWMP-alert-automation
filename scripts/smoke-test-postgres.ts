// Self-contained regression smoke test for the PostgreSQL runtime using pg-mem.
// It covers server-side session storage fallback, CSRF, RBAC entry, endpoint verification,
// staff invitations, required TOTP enrollment, and protected dashboard access.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { generateSync } from 'otplib';

const port = 3999;
const base = `http://127.0.0.1:${port}`;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index-pg.ts'], {
  cwd: projectRoot,
  env: { ...process.env, DATABASE_URL: 'pgmem://', SEED_DEMO_DATA: 'true', NODE_ENV: 'development', SCHEDULER_ENABLED: 'false', TERMII_WEBHOOK_SECRET: 'test-termii-webhook-secret', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });

type JsonRecord = Record<string, any>;
type RequestOptions = {
  method?: string;
  body?: unknown;
  csrf?: string;
  jar?: Map<string, string>;
  extraHeaders?: Record<string, string>;
};
const cookieJar = new Map<string, string>();
async function request<T extends JsonRecord = JsonRecord>(requestPath: string, { method = 'GET', body, csrf, jar = cookieJar, extraHeaders = {} }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (jar.size) headers.cookie = [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  if (csrf) headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${requestPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
  for (const cookie of cookies) { const [pair] = cookie.split(';'); const separator = pair.indexOf('='); if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1)); }
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${requestPath}: ${data?.error?.code || response.status} ${data?.error?.message || ''}`);
  return data;
}
async function csrfFor(jar: Map<string, string> = cookieJar): Promise<string> { return (await request('/api/auth/csrf', { jar })).csrfToken; }

try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { const health = await fetch(`${base}/api/health`); if (health.ok) break; } catch { /* wait for listener */ }
    await wait(100);
    if (attempt === 29) throw new Error(`Test runtime did not become healthy. ${logs}`);
  }
  const csrf = await csrfFor();
  const login = await request('/api/auth/login', { method: 'POST', csrf, body: { email: 'owner@livingwater.demo', password: 'LivingWater@2026' } });
  if (login.user?.role !== 'owner') throw new Error('Owner sign-in failed.');
  const dashboard = await request('/api/dashboard');
  if (dashboard.stats?.activeMembers !== 3) throw new Error('Dashboard did not return expected test data.');
  const settings = await request('/api/settings');
  if (settings.rule?.alertTime !== '07:30') throw new Error('PostgreSQL rule DTO is not compatible with the frontend.');
  const baseMember = { lastName: 'Sequence', preferredName: null, birthMonth: 1, birthDay: 2, birthYear: 1990, status: 'active', ministryGroup: 'General', birthdayAlertAllowed: false, consentRecorded: true };
  const createdMembers = await Promise.all([
    request('/api/members', { method: 'POST', csrf, body: { ...baseMember, firstName: 'Atomic One', phone: '08030000031' } }),
    request('/api/members', { method: 'POST', csrf, body: { ...baseMember, firstName: 'Atomic Two', phone: '08030000032' } }),
  ]);
  const assignedCodes = createdMembers.map((result) => result.member.memberCode).sort();
  if (assignedCodes.join(',') !== 'LW-1004,LW-1005') throw new Error(`Concurrent member-code allocation was not atomic: ${assignedCodes.join(',')}`);
  const scheduled = await request('/api/notifications/run', { method: 'POST', csrf, body: {} });
  if (scheduled.result?.created !== 3 || scheduled.result?.jobsProcessed !== 3) throw new Error('Birthday notifications were not durably queued and processed.');
  const afterRun = await request('/api/notifications');
  const primary = afterRun.items.find((item) => item.userId === 'usr_owner' && item.type === 'birthday_digest' && item.channel === 'whatsapp' && item.provider === 'mock');
  if (!primary?.providerMessageId || primary.status !== 'delivered') throw new Error('Outbox delivery did not produce a delivered primary WhatsApp record.');
  await request('/api/webhooks/whatsapp', { method: 'POST', body: { entry: [{ changes: [{ value: { statuses: [{ id: primary.providerMessageId, status: 'failed' }] } }] }] } });
  const fallbackQueued = (await request('/api/notifications')).items.find((item) => item.type === 'birthday_digest' && item.channel === 'sms' && item.notificationKey?.includes(':sms:fallback'));
  if (!fallbackQueued || fallbackQueued.status !== 'queued') throw new Error('A failed WhatsApp callback did not queue the idempotent SMS fallback.');
  const retryRun = await request('/api/notifications/run', { method: 'POST', csrf, body: {} });
  if (retryRun.result?.jobsProcessed < 1) throw new Error('The worker-compatible outbox did not process the queued SMS fallback.');
  const fallbackDelivered = (await request('/api/notifications')).items.find((item) => item.id === fallbackQueued.id);
  if (fallbackDelivered?.status !== 'delivered') throw new Error('SMS fallback did not complete through the outbox worker path.');
  const smsDeliveryPayload = { message_id: fallbackDelivered.providerMessageId, status: 'Delivered' };
  const termiiSignature = crypto.createHmac('sha512', 'test-termii-webhook-secret').update(JSON.stringify(smsDeliveryPayload)).digest('hex');
  await request('/api/webhooks/sms', { method: 'POST', body: smsDeliveryPayload, extraHeaders: { 'x-termii-signature': termiiSignature } });

  const endpoint = await request('/api/endpoints', { method: 'POST', csrf, body: { channel: 'sms', phone: '08030000017', label: 'Automated PG endpoint', priority: 3, optInConfirmed: true } });
  if (!endpoint.verification?.debugCode) throw new Error('Mock endpoint verification code was not returned in test mode.');
  const verified = await request(`/api/endpoints/${endpoint.endpoint.id}/verification/confirm`, { method: 'POST', csrf, body: { code: endpoint.verification.debugCode } });
  if (!verified.endpoint?.verifiedAt) throw new Error('Endpoint verification did not persist.');

  const invitation = await request('/api/staff/invitations', { method: 'POST', csrf, body: { fullName: 'Automated PostgreSQL Tester', email: 'automated.pg@example.test', role: 'auditor', groupScope: [] } });
  const token = invitation.invitation?.debugInviteLink?.split('/').pop();
  if (!token) throw new Error('Mock staff invitation link was not created.');
  const inviteJar = new Map(); const inviteCsrf = await csrfFor(inviteJar);
  const accepted = await request(`/api/invitations/${token}/accept`, { method: 'POST', csrf: inviteCsrf, jar: inviteJar, body: { password: 'AutomatedTesterPass2026' } });
  if (!accepted.enrollmentRequired) throw new Error('New staff account was not forced into MFA enrollment.');
  const setup = await request('/api/auth/mfa/totp/start', { method: 'POST', csrf: inviteCsrf, jar: inviteJar });
  const code = generateSync({ secret: setup.enrollment.manualKey });
  const completed = await request('/api/auth/mfa/totp/confirm', { method: 'POST', csrf: inviteCsrf, jar: inviteJar, body: { code } });
  if (completed.recoveryCodes?.length !== 10) throw new Error('TOTP setup did not issue ten recovery codes.');
  const protectedDashboard = await request('/api/dashboard', { jar: inviteJar });
  if (!protectedDashboard.date) throw new Error('New staff account did not receive access after MFA.');
  console.log('PostgreSQL runtime smoke test passed.');
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  console.error(logs);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), wait(1500)]);
}
