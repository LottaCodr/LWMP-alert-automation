import crypto from 'node:crypto';
import { config, providerRequestTimeoutMs } from './config.js';
import { ApiError, errorMessage } from './errors.js';
import { audit, db, decryptValue, encryptValue, endpointDto, newId, nowIso } from './database-pg.js';
import { PARISH_TIMEZONE, addDays, lagosDateParts, parseIsoDate, toIsoDate } from './domain/calendar.js';
import { endpointVerificationMessage, messageForDigest, messageForTest } from './domain/messaging.js';
import { providerPhoneDigits } from './domain/phone.js';
import { birthdayMatchesDate } from './domain/calendar.js';
import type {
  AdminEndpointRow,
  CountRow,
  DateParts,
  DeliveryChannel,
  DeliveryOutcome,
  EndpointDto,
  Feb29Policy,
  MemberRow,
  NotificationRow,
  NotificationRuleDto,
  NotificationRuleRow,
  NotificationStatus,
  NotificationType,
  OutboxJobRow,
  SafeUser,
  UserRow,
  BirthdayRunResult,
} from './types.js';

const DELIVERED_STATES: readonly NotificationStatus[] = ['provider_accepted', 'sent', 'delivered', 'read'];
const MAX_JOB_ATTEMPTS = 5;

export interface DeliveryContext {
  memberCount?: number;
  type?: NotificationType;
}

function providerMode(): string {
  return config.MESSAGE_MODE;
}

async function getRule(): Promise<NotificationRuleRow | null> {
  return db.one<NotificationRuleRow>('SELECT * FROM notification_rules ORDER BY updated_at DESC LIMIT 1');
}

export function notificationRuleDto(rule: NotificationRuleRow): NotificationRuleDto {
  return {
    id: rule.id,
    name: rule.name,
    enabled: Boolean(rule.enabled),
    digestMode: rule.digest_mode,
    alertTime: rule.alert_time,
    timezone: rule.timezone,
    daysBefore: Number(rule.days_before),
    primaryChannel: rule.primary_channel,
    smsFallback: Boolean(rule.sms_fallback),
    feb29Policy: rule.feb29_policy,
    updatedAt: rule.updated_at,
  };
}

async function readEligibleMembers(date: DateParts, feb29Policy: Feb29Policy): Promise<MemberRow[]> {
  const members = await db.all<MemberRow>(
    `SELECT * FROM members WHERE status = 'active' AND birthday_alert_allowed = TRUE AND consent_status != 'withdrawn'`,
  );
  return members.filter((member) => birthdayMatchesDate(member, date, feb29Policy));
}

/** Birthday Coordinators see only the ministry groups they were granted. */
function isMemberVisibleToUser(member: MemberRow, user: UserRow): boolean {
  if (user.role !== 'birthday_coordinator') return true;
  const scope: string[] = JSON.parse(user.group_scope || '[]') as string[];
  return scope.length === 0 || scope.includes(member.ministry_group);
}

async function getRecipientUsers(): Promise<UserRow[]> {
  return db.all<UserRow>(
    `SELECT DISTINCT u.* FROM users u
       INNER JOIN admin_endpoints endpoint ON endpoint.user_id = u.id
      WHERE u.active = TRUE
        AND u.role IN ('owner','membership_officer','birthday_coordinator')
        AND endpoint.enabled = TRUE
        AND endpoint.verified_at IS NOT NULL
        AND endpoint.opted_in_at IS NOT NULL
        AND endpoint.opted_out_at IS NULL
      ORDER BY u.full_name`,
  );
}

async function listUsableEndpoints(userId: string): Promise<AdminEndpointRow[]> {
  return db.all<AdminEndpointRow>(
    `SELECT * FROM admin_endpoints
      WHERE user_id = ? AND enabled = TRUE AND verified_at IS NOT NULL AND opted_in_at IS NOT NULL AND opted_out_at IS NULL
      ORDER BY priority ASC, created_at ASC`,
    userId,
  );
}

/**
 * Choose the endpoint for a user: the configured primary channel first, then an
 * SMS/WhatsApp fallback when the rule allows one, then any usable endpoint that
 * is not the excluded channel.
 */
async function selectEndpoint(
  userId: string,
  rule: NotificationRuleRow,
  excludedChannel: DeliveryChannel | null = null,
): Promise<AdminEndpointRow | null> {
  const endpoints = await listUsableEndpoints(userId);
  const firstFor = (channel: DeliveryChannel): AdminEndpointRow | undefined =>
    endpoints.find((endpoint) => endpoint.channel === channel && endpoint.channel !== excludedChannel);

  return (
    firstFor(rule.primary_channel) ??
    (rule.sms_fallback && rule.primary_channel === 'whatsapp' ? firstFor('sms') : undefined) ??
    (rule.sms_fallback && rule.primary_channel === 'sms' ? firstFor('whatsapp') : undefined) ??
    endpoints.find((endpoint) => endpoint.channel !== excludedChannel) ??
    null
  );
}

async function providerFetch(url: string, options: RequestInit): Promise<Response> {
  return fetch(url, { ...options, signal: AbortSignal.timeout(providerRequestTimeoutMs()) });
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

async function sendWithMeta(endpoint: AdminEndpointRow, { memberCount }: DeliveryContext): Promise<DeliveryOutcome> {
  const token = config.META_WHATSAPP_TOKEN;
  const phoneNumberId = config.META_PHONE_NUMBER_ID;
  const templateName = config.META_BIRTHDAY_TEMPLATE;
  if (!token || !phoneNumberId || !templateName) {
    throw new Error(
      'Meta WhatsApp credentials/template are not configured. Keep MESSAGE_MODE=mock until they are available.',
    );
  }
  const response = await providerFetch(
    `https://graph.facebook.com/${config.META_GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: providerPhoneDigits(decryptValue(endpoint.phone_encrypted)),
        type: 'template',
        template: {
          name: templateName,
          language: { code: config.META_TEMPLATE_LANGUAGE },
          components: [{ type: 'body', parameters: [{ type: 'text', text: String(memberCount ?? 0) }] }],
        },
      }),
    },
  );
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
    messages?: Array<{ id?: string }>;
  };
  if (!response.ok) throw new Error(payload?.error?.message || 'Meta WhatsApp API rejected the message.');
  return {
    provider: 'meta',
    providerMessageId: payload?.messages?.[0]?.id ?? null,
    status: 'provider_accepted',
  };
}

async function sendWithTermii(endpoint: AdminEndpointRow, content: string): Promise<DeliveryOutcome> {
  const apiKey = config.TERMII_API_KEY;
  const senderId = config.TERMII_SENDER_ID;
  if (!apiKey || !senderId) {
    throw new Error(
      'Termii credentials/sender ID are not configured. Keep MESSAGE_MODE=mock until they are available.',
    );
  }
  const response = await providerFetch(`${config.TERMII_BASE_URL}/api/sms/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      to: providerPhoneDigits(decryptValue(endpoint.phone_encrypted)),
      from: senderId,
      sms: content,
      channel: config.TERMII_SMS_CHANNEL,
      type: 'plain',
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    message_id?: string;
    message_id_str?: string;
  };
  if (!response.ok || payload?.code === 'error') throw new Error(payload?.message || 'Termii rejected the SMS.');
  return {
    provider: 'termii',
    providerMessageId: payload.message_id_str ?? payload.message_id ?? null,
    status: 'provider_accepted',
  };
}

async function sendMessage(
  endpoint: AdminEndpointRow,
  content: string,
  details: DeliveryContext = {},
): Promise<DeliveryOutcome> {
  if (providerMode() === 'mock') {
    return {
      provider: 'mock',
      providerMessageId: `${endpoint.channel === 'whatsapp' ? 'mock_wa_' : 'mock_sms_'}${crypto.randomUUID()}`,
      status: 'delivered',
      deliveredAt: nowIso(),
    };
  }
  if (endpoint.channel === 'whatsapp') return sendWithMeta(endpoint, details);
  return sendWithTermii(endpoint, content);
}

async function sendTermiiOtp(phone: string): Promise<DeliveryOutcome> {
  const apiKey = config.TERMII_API_KEY;
  const senderId = config.TERMII_SENDER_ID;
  if (!apiKey || !senderId) throw new Error('Termii OTP credentials/sender ID are not configured.');
  const response = await providerFetch(`${config.TERMII_BASE_URL}/api/sms/otp/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      message_type: 'NUMERIC',
      to: providerPhoneDigits(phone),
      from: senderId,
      channel: config.TERMII_SMS_CHANNEL,
      pin_attempts: 5,
      pin_time_to_live: 10,
      pin_length: 6,
      pin_placeholder: '< 123456 >',
      message_text: 'Living Water verification code: < 123456 >. It expires in 10 minutes. Do not share this code.',
      pin_type: 'NUMERIC',
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    pinId?: string;
    pin_id?: string;
  };
  const pinId = payload.pinId ?? payload.pin_id;
  if (!response.ok || payload?.code === 'error' || !pinId) {
    throw new Error(payload?.message || 'Termii could not create the verification code.');
  }
  return { provider: 'termii_otp', providerMessageId: pinId, providerManaged: true, status: 'provider_accepted' };
}

export async function verifyTermiiOtp(pinId: string | null, code: string): Promise<boolean> {
  if (!config.TERMII_API_KEY || !pinId) return false;
  const response = await providerFetch(`${config.TERMII_BASE_URL}/api/sms/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: config.TERMII_API_KEY, pin_id: pinId, pin: code }),
  });
  const payload = (await response.json().catch(() => ({}))) as { verified?: boolean | string };
  return Boolean(response.ok && (payload.verified === true || String(payload.verified).toLowerCase() === 'true'));
}

export async function sendEndpointVerificationSms(phone: string, code: string): Promise<DeliveryOutcome> {
  if (providerMode() !== 'mock' && config.TERMII_OTP_MODE !== 'local') return sendTermiiOtp(phone);
  return sendMessage(
    { channel: 'sms', phone_encrypted: encryptValue(phone) } as AdminEndpointRow,
    endpointVerificationMessage(code),
    { type: 'endpoint_verification' },
  );
}

/* ------------------------------------------------------------------ *
 * Notifications and the durable outbox
 * ------------------------------------------------------------------ */

interface InsertNotificationInput {
  key: string;
  userId: string;
  endpointId: string;
  channel: DeliveryChannel;
  scheduledFor: string;
  content: string;
  memberCount: number;
  type?: NotificationType;
}

async function insertNotification({
  key,
  userId,
  endpointId,
  channel,
  scheduledFor,
  content,
  memberCount,
  type = 'birthday_digest',
}: InsertNotificationInput): Promise<NotificationRow | null> {
  return db.one<NotificationRow>(
    `INSERT INTO notifications (id, notification_key, user_id, endpoint_id, channel, notification_type, scheduled_for, message_preview, member_count, status, attempts, created_at, last_event_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
     ON CONFLICT(notification_key) DO NOTHING RETURNING *`,
    newId('notif_'),
    key,
    userId,
    endpointId,
    channel,
    type,
    scheduledFor,
    content,
    memberCount,
    nowIso(),
    nowIso(),
  );
}

interface AttemptOutcome {
  ok: boolean;
  status: string;
  notificationId: string;
  error?: string;
}

async function attemptNotification(
  notification: NotificationRow,
  endpoint: AdminEndpointRow,
  content: string,
  details: DeliveryContext,
): Promise<AttemptOutcome> {
  const attemptedAt = nowIso();
  await db.run(
    `UPDATE notifications SET attempts = attempts + 1, status = 'queued', last_event_at = ?, error_code = NULL, error_message = NULL WHERE id = ?`,
    attemptedAt,
    notification.id,
  );
  try {
    const delivery = await sendMessage(endpoint, content, details);
    const sentAt = nowIso();
    await db.run(
      `UPDATE notifications SET status = ?, provider = ?, provider_message_id = ?, sent_at = ?, delivered_at = ?, last_event_at = ? WHERE id = ?`,
      delivery.status,
      delivery.provider,
      delivery.providerMessageId,
      sentAt,
      delivery.deliveredAt ?? null,
      delivery.deliveredAt ?? sentAt,
      notification.id,
    );
    return { ok: true, status: delivery.status, notificationId: notification.id };
  } catch (error) {
    const message = errorMessage(error);
    await db.run(
      `UPDATE notifications SET status = 'failed', error_code = 'PROVIDER_ERROR', error_message = ?, last_event_at = ? WHERE id = ?`,
      message.slice(0, 500),
      nowIso(),
      notification.id,
    );
    return { ok: false, status: 'failed', notificationId: notification.id, error: message };
  }
}

type FallbackOutcome = { duplicate: true } | { queued: true; notificationId: string } | null;

/** One idempotent SMS fallback per failed WhatsApp birthday digest. */
async function queueSmsFallbackForFailedWhatsApp(notification: NotificationRow): Promise<FallbackOutcome> {
  if (notification.channel !== 'whatsapp' || notification.notification_type !== 'birthday_digest') return null;
  const rule = await getRule();
  if (!rule?.sms_fallback) return null;

  const user = await db.one<UserRow>('SELECT * FROM users WHERE id = ? AND active = TRUE', notification.user_id);
  const primaryEndpoint = await db.one<AdminEndpointRow>(
    'SELECT * FROM admin_endpoints WHERE id = ?',
    notification.endpoint_id,
  );
  if (!user || !primaryEndpoint || primaryEndpoint.channel !== 'whatsapp') return null;

  const smsEndpoint = await selectEndpoint(user.id, rule, 'whatsapp');
  if (!smsEndpoint || smsEndpoint.channel !== 'sms') return null;

  const deliveryDate = parseIsoDate(notification.scheduled_for);
  if (!deliveryDate) return null;

  const leadDays = Number(rule.days_before || 0);
  const birthdayDate = addDays(deliveryDate, leadDays);
  const content = messageForDigest(Number(notification.member_count), birthdayDate, leadDays);

  const fallback = await insertNotification({
    key: `birthday-digest:${toIsoDate(birthdayDate)}:lead-${rule.days_before}:${user.id}:sms:fallback`,
    userId: user.id,
    endpointId: smsEndpoint.id,
    channel: 'sms',
    scheduledFor: toIsoDate(deliveryDate),
    content,
    memberCount: Number(notification.member_count),
  });
  if (!fallback) return { duplicate: true };

  await queueOutboxJob('notification_delivery', { notificationId: fallback.id });
  await audit({
    actorId: 'system',
    actorName: 'Delivery worker',
    action: 'sms_fallback_queued',
    entityType: 'notification',
    entityId: fallback.id,
    summary: 'Queued SMS fallback after a WhatsApp birthday digest delivery failure.',
    metadata: { failedNotificationId: notification.id },
  });
  return { queued: true, notificationId: fallback.id };
}

export interface RunBirthdayNotificationsInput {
  date?: string | null;
  actor?: SafeUser | null;
}

export async function runBirthdayNotifications({
  date: requestedDate = null,
  actor = null,
}: RunBirthdayNotificationsInput = {}): Promise<BirthdayRunResult> {
  const deliveryDate = requestedDate ? parseIsoDate(requestedDate) : lagosDateParts();
  if (!deliveryDate) throw ApiError.unprocessable('Use a valid ISO date such as 2026-08-31.', 'INVALID_RUN_DATE');

  const rule = await getRule();
  if (!rule?.enabled) {
    return { date: toIsoDate(deliveryDate), disabled: true, created: 0, skipped: 0, results: [] };
  }

  const leadDays = Number(rule.days_before || 0);
  const birthdayDate = addDays(deliveryDate, leadDays);
  const matchingMembers = await readEligibleMembers(birthdayDate, rule.feb29_policy);
  const recipients = await getRecipientUsers();
  const results: BirthdayRunResult['results'] = [];
  let created = 0;
  let skipped = 0;

  for (const user of recipients) {
    const visibleMembers = matchingMembers.filter((member) => isMemberVisibleToUser(member, user));
    if (!visibleMembers.length) {
      skipped += 1;
      continue;
    }
    const endpoint = await selectEndpoint(user.id, rule);
    if (!endpoint) {
      skipped += 1;
      continue;
    }
    const content = messageForDigest(visibleMembers.length, birthdayDate, leadDays);
    const notification = await insertNotification({
      key: `birthday-digest:${toIsoDate(birthdayDate)}:lead-${rule.days_before}:${user.id}:${endpoint.channel}`,
      userId: user.id,
      endpointId: endpoint.id,
      channel: endpoint.channel,
      scheduledFor: toIsoDate(deliveryDate),
      content,
      memberCount: visibleMembers.length,
    });
    if (!notification) {
      skipped += 1;
      results.push({ userId: user.id, status: 'duplicate_suppressed' });
      continue;
    }
    await queueOutboxJob('notification_delivery', { notificationId: notification.id });
    created += 1;
    results.push({ userId: user.id, channel: endpoint.channel, notificationId: notification.id, status: 'queued' });
  }

  await audit({
    actorId: actor?.id ?? 'system',
    actorName: actor?.fullName ?? 'Scheduler',
    action: 'birthday_digest_run',
    entityType: 'notification_rule',
    entityId: rule.id,
    summary: `Birthday digest evaluated for ${toIsoDate(deliveryDate)} against ${toIsoDate(birthdayDate)}: ${matchingMembers.length} eligible member(s), ${created} notification job(s) queued.`,
    metadata: {
      deliveryDate: toIsoDate(deliveryDate),
      birthdayDate: toIsoDate(birthdayDate),
      leadDays,
      matchingMembers: matchingMembers.length,
      created,
      skipped,
    },
  });

  return {
    date: toIsoDate(deliveryDate),
    birthdayDate: toIsoDate(birthdayDate),
    leadDays,
    matchingMembers: matchingMembers.length,
    created,
    skipped,
    results,
  };
}

export interface TestNotificationResult {
  ok: boolean;
  status: NotificationStatus | 'queued';
  notificationId: string;
  channel: DeliveryChannel;
  mode: string;
}

export async function sendTestNotification(user: SafeUser): Promise<TestNotificationResult> {
  const rule = await getRule();
  if (!rule) throw ApiError.unavailable('The parish notification rule has not been created yet.');
  const endpoint = await selectEndpoint(user.id, rule);
  if (!endpoint) {
    throw ApiError.unprocessable(
      'No verified, opted-in notification endpoint is available for your account.',
      'NO_USABLE_ENDPOINT',
    );
  }

  const scheduledFor = toIsoDate(lagosDateParts());
  const notification = await insertNotification({
    key: `test:${scheduledFor}:${user.id}:${endpoint.channel}:${crypto.randomUUID()}`,
    userId: user.id,
    endpointId: endpoint.id,
    channel: endpoint.channel,
    scheduledFor,
    content: messageForTest(endpoint.channel),
    memberCount: 0,
    type: 'test',
  });
  if (!notification) throw ApiError.conflict('This test notification was already recorded.', 'DUPLICATE_NOTIFICATION');

  const deliveryJobId = await queueOutboxJob('notification_delivery', { notificationId: notification.id });
  // A test is explicitly requested by a signed-in user, so process its already-durable job now.
  await processOutboxJobs({ limit: 1, jobId: deliveryJobId });
  const finalNotification = await db.one<NotificationRow>('SELECT * FROM notifications WHERE id = ?', notification.id);
  await audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'test_notification_queued',
    entityType: 'notification',
    entityId: notification.id,
    summary: `Queued and attempted a ${endpoint.channel} test notification in ${providerMode()} mode.`,
  });

  return {
    ok: DELIVERED_STATES.includes(finalNotification?.status ?? 'queued'),
    status: finalNotification?.status ?? 'queued',
    notificationId: notification.id,
    channel: endpoint.channel,
    mode: providerMode(),
  };
}

export async function queueOutboxJob(
  jobType: string,
  payload: Record<string, unknown>,
  dueAt: string = nowIso(),
): Promise<string> {
  const id = newId('job_');
  const timestamp = nowIso();
  await db.run(
    `INSERT INTO outbox_jobs (id, job_type, payload, due_at, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
    id,
    jobType,
    JSON.stringify(payload),
    dueAt,
    timestamp,
    timestamp,
  );
  return id;
}

function retryDueAt(attempts: number): string {
  const delayMinutes = Math.min(30, 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}

async function completeOutboxJob(id: string): Promise<void> {
  await db.run(
    `UPDATE outbox_jobs SET status = 'completed', updated_at = ?, last_error = NULL WHERE id = ?`,
    nowIso(),
    id,
  );
}

async function failOutboxJob(job: OutboxJobRow, error: unknown): Promise<void> {
  const attempts = Number(job.attempts || 0) + 1;
  const terminal = attempts >= MAX_JOB_ATTEMPTS;
  const message = errorMessage(error);
  await db.run(
    `UPDATE outbox_jobs SET status = ?, due_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    terminal ? 'dead_letter' : 'failed',
    terminal ? nowIso() : retryDueAt(attempts),
    message.slice(0, 500),
    nowIso(),
    job.id,
  );
  if (terminal) {
    await audit({
      actorId: 'system',
      actorName: 'Delivery worker',
      action: 'outbox_job_dead_lettered',
      entityType: 'outbox_job',
      entityId: job.id,
      summary: `Delivery job exhausted ${MAX_JOB_ATTEMPTS} attempts: ${job.job_type}.`,
      metadata: { error: message.slice(0, 250) },
    });
  }
}

export interface ProcessOutboxOptions {
  limit?: number;
  jobId?: string | null;
}

/**
 * Claim due jobs inside a transaction using `FOR UPDATE SKIP LOCKED` so several
 * workers can run safely, then attempt each one outside the transaction.
 */
export async function processOutboxJobs({ limit = 25, jobId = null }: ProcessOutboxOptions = {}): Promise<number> {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const lockingClause =
    config.DATABASE_URL === 'pgmem://' || config.DATABASE_URL === 'pgmem:' ? '' : ' FOR UPDATE SKIP LOCKED';

  const jobs = await db.transaction(async (tx) => {
    const jobFilter = jobId ? 'AND id = ?' : '';
    const params: unknown[] = [nowIso(), staleBefore];
    if (jobId) params.push(jobId);
    params.push(safeLimit);
    const claimed = await tx.all<OutboxJobRow>(
      `SELECT * FROM outbox_jobs
        WHERE (((status IN ('pending','failed')) AND due_at <= ?) OR (status = 'processing' AND updated_at <= ?)) ${jobFilter} AND attempts < ${MAX_JOB_ATTEMPTS}
        ORDER BY due_at ASC LIMIT ?${lockingClause}`,
      ...params,
    );
    for (const job of claimed) {
      await tx.run(
        `UPDATE outbox_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
        nowIso(),
        job.id,
      );
    }
    return claimed;
  });

  for (const job of jobs) {
    try {
      if (job.job_type !== 'notification_delivery') throw new Error(`Unsupported outbox job type: ${job.job_type}`);
      const payload = JSON.parse(job.payload || '{}') as { notificationId?: string };
      const notification = payload.notificationId
        ? await db.one<NotificationRow>('SELECT * FROM notifications WHERE id = ?', payload.notificationId)
        : null;
      if (!notification) throw new Error('Notification referenced by delivery job no longer exists.');
      if (DELIVERED_STATES.includes(notification.status)) {
        await completeOutboxJob(job.id);
        continue;
      }
      const endpoint = await db.one<AdminEndpointRow>(
        `SELECT * FROM admin_endpoints WHERE id = ? AND enabled = TRUE AND verified_at IS NOT NULL AND opted_in_at IS NOT NULL AND opted_out_at IS NULL`,
        notification.endpoint_id,
      );
      if (!endpoint) {
        await db.run(
          `UPDATE notifications SET status = 'failed', error_code = 'ENDPOINT_UNAVAILABLE', error_message = 'The verified notification endpoint is no longer available.', last_event_at = ? WHERE id = ?`,
          nowIso(),
          notification.id,
        );
        await completeOutboxJob(job.id);
        continue;
      }
      const outcome = await attemptNotification(notification, endpoint, notification.message_preview, {
        memberCount: Number(notification.member_count),
        type: notification.notification_type,
      });
      if (!outcome.ok) {
        const fallback = await queueSmsFallbackForFailedWhatsApp(notification);
        await audit({
          actorId: 'system',
          actorName: 'Delivery worker',
          action: 'notification_delivery_failed',
          entityType: 'notification',
          entityId: notification.id,
          summary: 'A notification delivery attempt failed and will retry if eligible.',
          metadata: { fallbackQueued: Boolean(fallback && 'queued' in fallback), error: outcome.error },
        });
        throw new Error(outcome.error || 'Notification provider rejected the delivery.');
      }
      await completeOutboxJob(job.id);
    } catch (error) {
      await failOutboxJob(job, error);
    }
  }
  return jobs.length;
}

/* ------------------------------------------------------------------ *
 * Settings and endpoints
 * ------------------------------------------------------------------ */

export async function listUserEndpoints(
  user: SafeUser,
  { revealPhone = false }: { revealPhone?: boolean } = {},
): Promise<EndpointDto[]> {
  const rows = await db.all<AdminEndpointRow>(
    'SELECT * FROM admin_endpoints WHERE user_id = ? ORDER BY priority, created_at',
    user.id,
  );
  return rows.map((row) => endpointDto(row, { revealPhone }));
}

export interface NotificationRuleInput {
  enabled: boolean;
  digestMode: 'daily_digest';
  alertTime: string;
  daysBefore: number;
  primaryChannel: DeliveryChannel;
  smsFallback: boolean;
  feb29Policy: Feb29Policy;
}

export async function updateNotificationRule(
  values: NotificationRuleInput,
  user: SafeUser,
): Promise<NotificationRuleDto> {
  const rule = await getRule();
  if (!rule) throw ApiError.unavailable('The parish notification rule has not been created yet.');
  await db.run(
    `UPDATE notification_rules SET enabled = ?, digest_mode = ?, alert_time = ?, timezone = ?, days_before = ?, primary_channel = ?, sms_fallback = ?, feb29_policy = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
    values.enabled,
    values.digestMode,
    values.alertTime,
    PARISH_TIMEZONE,
    values.daysBefore,
    values.primaryChannel,
    values.smsFallback,
    values.feb29Policy,
    nowIso(),
    user.id,
    rule.id,
  );
  await audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'notification_rule_updated',
    entityType: 'notification_rule',
    entityId: rule.id,
    summary: 'Updated daily birthday care notification settings.',
    metadata: { ...values },
  });
  const updated = await getRule();
  if (!updated) throw ApiError.unavailable('The notification rule disappeared while being updated.');
  return notificationRuleDto(updated);
}

export async function getNotificationRuleDto(): Promise<NotificationRuleDto | null> {
  const rule = await getRule();
  return rule ? notificationRuleDto(rule) : null;
}

/* ------------------------------------------------------------------ *
 * Provider webhooks
 * ------------------------------------------------------------------ */

export interface ProviderStatusInput {
  provider: string;
  providerMessageId: string | null;
  status: string;
  eventHash: string;
  eventType: string;
}

export type ProviderStatusResult =
  | { ignored: true }
  | { duplicate: true }
  | { unmatched: true }
  | { updated: true; notificationId: string; status: NotificationStatus; fallback: FallbackOutcome };

export async function applyProviderStatus({
  provider,
  providerMessageId,
  status,
  eventHash,
  eventType,
}: ProviderStatusInput): Promise<ProviderStatusResult> {
  if (!eventHash) return { ignored: true };

  const result = await db.transaction(async (tx) => {
    const notification = providerMessageId
      ? await tx.one<NotificationRow>('SELECT * FROM notifications WHERE provider_message_id = ?', providerMessageId)
      : null;
    const event = await tx.one<CountRow>(
      `INSERT INTO provider_events (id, provider, event_hash, notification_id, event_type, payload_summary, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_hash) DO NOTHING RETURNING id`,
      newId('event_'),
      provider,
      eventHash,
      notification?.id ?? null,
      eventType,
      JSON.stringify({ providerMessageId, status }),
      nowIso(),
    );
    if (!event) return { duplicate: true } as const;
    if (!notification) return { unmatched: true } as const;

    const mapped: NotificationStatus = (
      ['delivered', 'read', 'failed', 'sent', 'provider_accepted'] as NotificationStatus[]
    ).includes(status as NotificationStatus)
      ? (status as NotificationStatus)
      : 'provider_accepted';
    await tx.run(
      `UPDATE notifications SET status = ?, delivered_at = CASE WHEN ? IN ('delivered','read') THEN ? ELSE delivered_at END, read_at = CASE WHEN ? = 'read' THEN ? ELSE read_at END, last_event_at = ? WHERE id = ?`,
      mapped,
      mapped,
      nowIso(),
      mapped,
      nowIso(),
      nowIso(),
      notification.id,
    );
    return { updated: true, notification, status: mapped } as const;
  });

  if (!('updated' in result) || !result.updated) return result;
  const fallback = result.status === 'failed' ? await queueSmsFallbackForFailedWhatsApp(result.notification) : null;
  return { updated: true, notificationId: result.notification.id, status: result.status, fallback };
}
