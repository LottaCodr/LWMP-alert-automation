import crypto from 'node:crypto';
import { db, audit, decryptValue, encryptValue, endpointDto, lagosDateParts, newId, nowIso, toIsoDate } from './database.js';

const DEFAULT_TIMEZONE = 'Africa/Lagos';
type ProviderDelivery = {
  provider: string;
  providerMessageId: string | null;
  status: string;
  deliveredAt?: string;
  providerManaged?: boolean;
};
type ProviderDetails = { memberCount?: number; type?: string; fallbackFor?: string };
type DataRow = Record<string, any>;


function parseIsoDate(input) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input || ''))) return null;
  const [year, month, day] = input.split('-').map(Number);
  const test = new Date(Date.UTC(year, month - 1, day));
  if (test.getUTCFullYear() !== year || test.getUTCMonth() !== month - 1 || test.getUTCDate() !== day) return null;
  return { year, month, day };
}

function prettyDate(parts) {
  return new Intl.DateTimeFormat('en-NG', {
    timeZone: DEFAULT_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)));
}

function addCalendarDays(parts, amount) {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() };
}

function getRule() {
  return db.prepare('SELECT * FROM notification_rules ORDER BY updated_at DESC LIMIT 1').get();
}

function birthdayMatches(member, date, feb29Policy) {
  if (member.birth_month === date.month && member.birth_day === date.day) return true;
  if (member.birth_month !== 2 || member.birth_day !== 29) return false;
  const isLeapYear = date.year % 4 === 0 && (date.year % 100 !== 0 || date.year % 400 === 0);
  if (isLeapYear) return date.month === 2 && date.day === 29;
  return feb29Policy === 'mar1' ? date.month === 3 && date.day === 1 : date.month === 2 && date.day === 28;
}

function readEligibleMembers(date) {
  const rule = getRule();
  const members = db.prepare(`
    SELECT * FROM members
    WHERE status = 'active' AND birthday_alert_allowed = 1 AND consent_status != 'withdrawn'
  `).all();
  return members.filter((member) => birthdayMatches(member, date, rule.feb29_policy));
}

function isMemberVisibleToUser(member, user) {
  if (user.role !== 'birthday_coordinator') return true;
  const scope = JSON.parse(user.group_scope || '[]');
  return scope.length === 0 || scope.includes(member.ministry_group);
}

function getRecipientUsers() {
  return db.prepare(`
    SELECT DISTINCT u.*
    FROM users u
    INNER JOIN admin_endpoints endpoint ON endpoint.user_id = u.id
    WHERE u.active = 1
      AND u.role IN ('owner', 'membership_officer', 'birthday_coordinator')
      AND endpoint.enabled = 1
      AND endpoint.verified_at IS NOT NULL
      AND endpoint.opted_in_at IS NOT NULL
      AND endpoint.opted_out_at IS NULL
    ORDER BY u.full_name
  `).all();
}

function selectEndpoint(userId, rule, excludedChannel = null) {
  const endpoints = db.prepare(`
    SELECT * FROM admin_endpoints
    WHERE user_id = ?
      AND enabled = 1
      AND verified_at IS NOT NULL
      AND opted_in_at IS NOT NULL
      AND opted_out_at IS NULL
    ORDER BY priority ASC, created_at ASC
  `).all(userId);

  const firstForChannel = (channel) => endpoints.find((endpoint) => endpoint.channel === channel && endpoint.channel !== excludedChannel);
  const primary = firstForChannel(rule.primary_channel);
  if (primary) return primary;
  if (rule.sms_fallback && rule.primary_channel === 'whatsapp') return firstForChannel('sms');
  if (rule.sms_fallback && rule.primary_channel === 'sms') return firstForChannel('whatsapp');
  return endpoints.find((endpoint) => endpoint.channel !== excludedChannel) || null;
}

function messageForDigest(memberCount, birthdayDate, daysBefore = 0) {
  const subject = memberCount === 1 ? '1 authorised birthday is due' : `${memberCount} authorised birthdays are due`;
  const timing = daysBefore === 0
    ? `on ${prettyDate(birthdayDate)}`
    : `in ${daysBefore} day${daysBefore === 1 ? '' : 's'} (${prettyDate(birthdayDate)})`;
  return `${subject} ${timing}. Sign in to the Living Water private dashboard to view the permitted list.`;
}

function messageForTest(channel) {
  return `Living Water Mega Parish: this is a ${channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} delivery test. No member data is included.`;
}

function providerMode() {
  return process.env.MESSAGE_MODE || 'mock';
}

function normalizedProviderPhone(endpoint) {
  const phone = decryptValue(endpoint.phone_encrypted);
  return phone ? phone.replace(/\D/g, '') : null;
}

async function sendWithMeta(endpoint: DataRow, { memberCount }: ProviderDetails): Promise<ProviderDelivery> {
  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const templateName = process.env.META_BIRTHDAY_TEMPLATE;
  if (!token || !phoneNumberId || !templateName) {
    throw new Error('Meta WhatsApp production credentials/template are not configured. Use MESSAGE_MODE=mock until they are available.');
  }
  const phone = normalizedProviderPhone(endpoint);
  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: process.env.META_TEMPLATE_LANGUAGE || 'en_US' },
      components: [{
        type: 'body',
        parameters: [{ type: 'text', text: String(memberCount || 0) }],
      }],
    },
  };
  const response = await fetch(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || 'Meta WhatsApp API rejected the message.');
  return { provider: 'meta', providerMessageId: payload?.messages?.[0]?.id || null, status: 'provider_accepted' };
}

async function sendWithTermii(endpoint: DataRow, content: string): Promise<ProviderDelivery> {
  const apiKey = process.env.TERMII_API_KEY;
  const senderId = process.env.TERMII_SENDER_ID;
  if (!apiKey || !senderId) {
    throw new Error('Termii production credentials/sender ID are not configured. Use MESSAGE_MODE=mock until they are available.');
  }
  const phone = normalizedProviderPhone(endpoint);
  const response = await fetch(`${process.env.TERMII_BASE_URL || 'https://v3.api.termii.com'}/api/sms/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      to: phone,
      from: senderId,
      sms: content,
      channel: process.env.TERMII_SMS_CHANNEL || 'dnd',
      type: 'plain',
    }),
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || payload?.code === 'error') throw new Error(payload?.message || 'Termii rejected the SMS.');
  return { provider: 'termii', providerMessageId: payload.message_id_str || payload.message_id || null, status: 'provider_accepted' };
}

async function sendMessage(endpoint: DataRow, content: string, details: ProviderDetails = {}): Promise<ProviderDelivery> {
  if (providerMode() === 'mock') {
    const prefix = endpoint.channel === 'whatsapp' ? 'mock_wa_' : 'mock_sms_';
    return {
      provider: 'mock',
      providerMessageId: `${prefix}${crypto.randomUUID()}`,
      status: 'delivered',
      deliveredAt: nowIso(),
    };
  }
  if (endpoint.channel === 'whatsapp') return sendWithMeta(endpoint, details);
  return sendWithTermii(endpoint, content);
}

async function sendTermiiOtp(phone) {
  const apiKey = process.env.TERMII_API_KEY;
  const senderId = process.env.TERMII_SENDER_ID;
  if (!apiKey || !senderId) throw new Error('Termii OTP credentials/sender ID are not configured.');
  const response = await fetch(`${process.env.TERMII_BASE_URL || 'https://v3.api.termii.com'}/api/sms/otp/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      message_type: 'NUMERIC',
      to: String(phone).replace(/\D/g, ''),
      from: senderId,
      channel: process.env.TERMII_SMS_CHANNEL || 'dnd',
      pin_attempts: 5,
      pin_time_to_live: 10,
      pin_length: 6,
      pin_placeholder: '< 123456 >',
      message_text: 'Living Water verification code: < 123456 >. It expires in 10 minutes. Do not share this code.',
      pin_type: 'NUMERIC',
    }),
  });
  const payload: any = await response.json().catch(() => ({}));
  const pinId = payload.pinId || payload.pin_id;
  if (!response.ok || payload?.code === 'error' || !pinId) throw new Error(payload?.message || 'Termii could not create the verification code.');
  return { provider: 'termii_otp', providerMessageId: pinId, providerManaged: true, status: 'provider_accepted' };
}

export async function verifyTermiiOtp(pinId, code) {
  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey || !pinId) return false;
  const response = await fetch(`${process.env.TERMII_BASE_URL || 'https://v3.api.termii.com'}/api/sms/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, pin_id: pinId, pin: code }),
  });
  const payload: any = await response.json().catch(() => ({}));
  return Boolean(response.ok && (payload.verified === true || String(payload.verified).toLowerCase() === 'true'));
}

export async function sendEndpointVerificationSms(phone, code) {
  // Verify ownership by SMS before any WhatsApp or SMS endpoint can receive protected operational alerts.
  // This deliberately uses SMS even for a WhatsApp endpoint: WhatsApp may not be used proactively until its opt-in is documented.
  if (providerMode() !== 'mock' && process.env.TERMII_OTP_MODE !== 'local') return sendTermiiOtp(phone);
  const endpoint = { channel: 'sms', phone_encrypted: encryptValue(phone) };
  const content = `Living Water verification code: ${code}. It expires in 10 minutes. Do not share this code.`;
  return sendMessage(endpoint, content, { type: 'endpoint_verification' });
}

function insertNotification({ key, userId, endpointId, channel, scheduledFor, content, memberCount, type = 'birthday_digest' }) {
  const id = newId('notif_');
  const createdAt = nowIso();
  const result = db.prepare(`
    INSERT INTO notifications (
      id, notification_key, user_id, endpoint_id, channel, notification_type, scheduled_for,
      message_preview, member_count, status, attempts, created_at, last_event_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
    ON CONFLICT(notification_key) DO NOTHING
  `).run(id, key, userId, endpointId, channel, type, scheduledFor, content, memberCount, createdAt, createdAt);
  return result.changes ? db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) : null;
}

async function attemptNotification(notification, endpoint, content, details) {
  const attemptedAt = nowIso();
  db.prepare(`
    UPDATE notifications
    SET attempts = attempts + 1, status = 'queued', last_event_at = ?, error_code = NULL, error_message = NULL
    WHERE id = ?
  `).run(attemptedAt, notification.id);

  try {
    const delivery = await sendMessage(endpoint, content, details);
    const sentAt = nowIso();
    db.prepare(`
      UPDATE notifications
      SET status = ?, provider = ?, provider_message_id = ?, sent_at = ?, delivered_at = ?, last_event_at = ?
      WHERE id = ?
    `).run(
      delivery.status,
      delivery.provider,
      delivery.providerMessageId,
      sentAt,
      delivery.deliveredAt || null,
      delivery.deliveredAt || sentAt,
      notification.id,
    );
    return { ok: true, status: delivery.status, notificationId: notification.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected provider error';
    db.prepare(`
      UPDATE notifications
      SET status = 'failed', error_code = 'PROVIDER_ERROR', error_message = ?, last_event_at = ?
      WHERE id = ?
    `).run(message.slice(0, 500), nowIso(), notification.id);
    return { ok: false, status: 'failed', notificationId: notification.id, error: message };
  }
}

async function sendFallbackIfNeeded({ outcome, user, deliveryDate, birthdayDate, memberCount, rule, primaryEndpoint }) {
  if (outcome.ok || !rule.sms_fallback || primaryEndpoint.channel !== 'whatsapp') return null;
  const smsEndpoint = selectEndpoint(user.id, rule, 'whatsapp');
  if (!smsEndpoint || smsEndpoint.channel !== 'sms') return null;
  const fallbackKey = `birthday-digest:${toIsoDate(birthdayDate)}:lead-${rule.days_before}:${user.id}:sms:fallback`;
  const content = messageForDigest(memberCount, birthdayDate, rule.days_before);
  const notification = insertNotification({
    key: fallbackKey,
    userId: user.id,
    endpointId: smsEndpoint.id,
    channel: 'sms',
    scheduledFor: toIsoDate(deliveryDate),
    content,
    memberCount,
  });
  if (!notification) return { duplicate: true };
  return attemptNotification(notification, smsEndpoint, content, { memberCount, type: 'birthday_digest' });
}

export async function runBirthdayNotifications({ date: requestedDate = null, actor = null } = {}) {
  const deliveryDate = requestedDate ? parseIsoDate(requestedDate) : lagosDateParts();
  if (!deliveryDate) throw new Error('Use a valid ISO date such as 2026-08-31.');
  const rule = getRule();
  if (!rule?.enabled) return { date: toIsoDate(deliveryDate), disabled: true, created: 0, skipped: 0, results: [] };

  const birthdayDate = addCalendarDays(deliveryDate, Number(rule.days_before || 0));
  const matchingMembers = readEligibleMembers(birthdayDate);
  const recipients = getRecipientUsers();
  const results = [];
  let created = 0;
  let skipped = 0;

  for (const user of recipients) {
    const visibleMembers = matchingMembers.filter((member) => isMemberVisibleToUser(member, user));
    if (!visibleMembers.length) {
      skipped += 1;
      continue;
    }
    const endpoint = selectEndpoint(user.id, rule);
    if (!endpoint) {
      skipped += 1;
      continue;
    }
    const key = `birthday-digest:${toIsoDate(birthdayDate)}:lead-${rule.days_before}:${user.id}:${endpoint.channel}`;
    const content = messageForDigest(visibleMembers.length, birthdayDate, rule.days_before);
    const notification = insertNotification({
      key,
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
    created += 1;
    const outcome = await attemptNotification(notification, endpoint, content, { memberCount: visibleMembers.length, type: 'birthday_digest' });
    const fallback = await sendFallbackIfNeeded({
      outcome,
      user,
      deliveryDate,
      birthdayDate,
      memberCount: visibleMembers.length,
      rule,
      primaryEndpoint: endpoint,
    });
    results.push({ userId: user.id, channel: endpoint.channel, ...outcome, fallback });
  }

  audit({
    actorId: actor?.id || 'system',
    actorName: actor?.fullName || 'Scheduler',
    action: 'birthday_digest_run',
    entityType: 'notification_rule',
    entityId: rule.id,
    summary: `Birthday digest evaluated for ${toIsoDate(deliveryDate)} against ${toIsoDate(birthdayDate)}: ${matchingMembers.length} eligible member(s), ${created} new notification(s).`,
    metadata: { deliveryDate: toIsoDate(deliveryDate), birthdayDate: toIsoDate(birthdayDate), leadDays: rule.days_before, matchingMembers: matchingMembers.length, created, skipped },
  });

  return {
    date: toIsoDate(deliveryDate),
    birthdayDate: toIsoDate(birthdayDate),
    leadDays: rule.days_before,
    matchingMembers: matchingMembers.length,
    created,
    skipped,
    results,
  };
}

export async function sendTestNotification(user) {
  const rule = getRule();
  const endpoint = selectEndpoint(user.id, rule);
  if (!endpoint) throw new Error('No verified, opted-in notification endpoint is available for your account.');
  const scheduledFor = toIsoDate(lagosDateParts());
  const key = `test:${scheduledFor}:${user.id}:${endpoint.channel}:${crypto.randomUUID()}`;
  const content = messageForTest(endpoint.channel);
  const notification = insertNotification({
    key,
    userId: user.id,
    endpointId: endpoint.id,
    channel: endpoint.channel,
    scheduledFor,
    content,
    memberCount: 0,
    type: 'test',
  });
  const outcome = await attemptNotification(notification, endpoint, content, { memberCount: 0, type: 'test' });
  audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'test_notification_sent',
    entityType: 'notification',
    entityId: notification.id,
    summary: `Sent a ${endpoint.channel} test notification in ${providerMode()} mode.`,
  });
  return { ...outcome, channel: endpoint.channel, mode: providerMode() };
}

export function queueOutboxJob(jobType, payload, dueAt = nowIso()) {
  const id = newId('job_');
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO outbox_jobs (id, job_type, payload, due_at, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(id, jobType, JSON.stringify(payload), dueAt, timestamp, timestamp);
  return id;
}

export function processOutboxJobs(limit = 50) {
  const jobs = db.prepare(`
    SELECT * FROM outbox_jobs
    WHERE status = 'pending' AND due_at <= ?
    ORDER BY due_at ASC
    LIMIT ?
  `).all(nowIso(), limit);
  for (const job of jobs) {
    db.prepare(`UPDATE outbox_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(nowIso(), job.id);
    try {
      // Member changes are durable and the birthday engine evaluates the current record on each run.
      // This job is the audited hand-off point for future occurrence pre-computation if scale requires it.
      db.prepare(`UPDATE outbox_jobs SET status = 'completed', updated_at = ?, last_error = NULL WHERE id = ?`).run(nowIso(), job.id);
    } catch (error) {
      db.prepare(`UPDATE outbox_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(String(error).slice(0, 500), nowIso(), job.id);
    }
  }
  return jobs.length;
}

export function listUserEndpoints(user, { revealPhone = false } = {}) {
  const rows = db.prepare('SELECT * FROM admin_endpoints WHERE user_id = ? ORDER BY priority, created_at').all(user.id);
  return rows.map((row) => endpointDto(row, { revealPhone }));
}

export function updateNotificationRule(values, user) {
  const rule = getRule();
  db.prepare(`
    UPDATE notification_rules
    SET enabled = ?, digest_mode = ?, alert_time = ?, timezone = ?, days_before = ?, primary_channel = ?, sms_fallback = ?, feb29_policy = ?, updated_at = ?, updated_by = ?
    WHERE id = ?
  `).run(
    values.enabled ? 1 : 0,
    values.digestMode,
    values.alertTime,
    DEFAULT_TIMEZONE,
    values.daysBefore,
    values.primaryChannel,
    values.smsFallback ? 1 : 0,
    values.feb29Policy,
    nowIso(),
    user.id,
    rule.id,
  );
  audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'notification_rule_updated',
    entityType: 'notification_rule',
    entityId: rule.id,
    summary: `Updated daily birthday care notification settings.`,
    metadata: { ...values },
  });
  return getRule();
}

export function getNotificationRuleDto() {
  const rule = getRule();
  return rule && {
    id: rule.id,
    name: rule.name,
    enabled: Boolean(rule.enabled),
    digestMode: rule.digest_mode,
    alertTime: rule.alert_time,
    timezone: rule.timezone,
    daysBefore: rule.days_before,
    primaryChannel: rule.primary_channel,
    smsFallback: Boolean(rule.sms_fallback),
    feb29Policy: rule.feb29_policy,
    updatedAt: rule.updated_at,
  };
}

export function applyProviderStatus({ provider, providerMessageId, status, eventHash, eventType = 'status' }) {
  const existing = db.prepare('SELECT id FROM provider_events WHERE event_hash = ?').get(eventHash);
  if (existing) return { duplicate: true };
  const notification = db.prepare('SELECT * FROM notifications WHERE provider_message_id = ?').get(providerMessageId);
  const notificationId = notification?.id || null;
  db.prepare(`
    INSERT INTO provider_events (id, provider, event_hash, notification_id, event_type, payload_summary, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId('provider_event_'), provider, eventHash, notificationId, eventType, `status=${status}; provider_message_id=${providerMessageId || 'unknown'}`, nowIso());

  if (!notification) return { duplicate: false, matched: false };
  const mapped = ['sent', 'delivered', 'read', 'failed'].includes(status) ? status : 'provider_accepted';
  const fields = {
    sent: { sent_at: nowIso() },
    delivered: { delivered_at: nowIso() },
    read: { read_at: nowIso() },
    failed: { error_code: 'PROVIDER_FAILED', error_message: 'Provider reported failed delivery.' },
  }[mapped] || {};
  db.prepare(`
    UPDATE notifications
    SET status = ?, sent_at = COALESCE(?, sent_at), delivered_at = COALESCE(?, delivered_at), read_at = COALESCE(?, read_at),
        error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message), last_event_at = ?
    WHERE id = ?
  `).run(mapped, fields.sent_at || null, fields.delivered_at || null, fields.read_at || null, fields.error_code || null, fields.error_message || null, nowIso(), notification.id);
  return { duplicate: false, matched: true, notificationId: notification.id };
}
