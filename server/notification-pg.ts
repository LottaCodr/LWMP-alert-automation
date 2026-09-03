import crypto from 'node:crypto';
import { audit, db, decryptValue, encryptValue, endpointDto, lagosDateParts, newId, nowIso, toIsoDate } from './database-pg.js';

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

function parseIsoDate(input) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input || ''))) return null; const [year, month, day] = input.split('-').map(Number); const test = new Date(Date.UTC(year, month - 1, day)); return test.getUTCFullYear() === year && test.getUTCMonth() === month - 1 && test.getUTCDate() === day ? { year, month, day } : null; }
function prettyDate(parts) { return new Intl.DateTimeFormat('en-NG', { timeZone: DEFAULT_TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12))); }
function addCalendarDays(parts, amount) { const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount)); return { year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, day: cursor.getUTCDate() }; }
async function getRule() { return db.one('SELECT * FROM notification_rules ORDER BY updated_at DESC LIMIT 1'); }
function birthdayMatches(member, date, feb29Policy) { if (Number(member.birth_month) === date.month && Number(member.birth_day) === date.day) return true; if (Number(member.birth_month) !== 2 || Number(member.birth_day) !== 29) return false; const leap = date.year % 4 === 0 && (date.year % 100 !== 0 || date.year % 400 === 0); return leap ? date.month === 2 && date.day === 29 : feb29Policy === 'mar1' ? date.month === 3 && date.day === 1 : date.month === 2 && date.day === 28; }
async function readEligibleMembers(date) { const rule = await getRule(); const members = await db.all(`SELECT * FROM members WHERE status = 'active' AND birthday_alert_allowed = TRUE AND consent_status != 'withdrawn'`); return members.filter((member) => birthdayMatches(member, date, rule.feb29_policy)); }
function isMemberVisibleToUser(member, user) { if (user.role !== 'birthday_coordinator') return true; const scope = JSON.parse(user.group_scope || '[]'); return scope.length === 0 || scope.includes(member.ministry_group); }
async function getRecipientUsers() { return db.all(`SELECT DISTINCT u.* FROM users u INNER JOIN admin_endpoints endpoint ON endpoint.user_id = u.id WHERE u.active = TRUE AND u.role IN ('owner','membership_officer','birthday_coordinator') AND endpoint.enabled = TRUE AND endpoint.verified_at IS NOT NULL AND endpoint.opted_in_at IS NOT NULL AND endpoint.opted_out_at IS NULL ORDER BY u.full_name`); }
async function selectEndpoint(userId, rule, excludedChannel = null) { const endpoints = await db.all(`SELECT * FROM admin_endpoints WHERE user_id = ? AND enabled = TRUE AND verified_at IS NOT NULL AND opted_in_at IS NOT NULL AND opted_out_at IS NULL ORDER BY priority ASC, created_at ASC`, userId); const first = (channel) => endpoints.find((endpoint) => endpoint.channel === channel && endpoint.channel !== excludedChannel); return first(rule.primary_channel) || (rule.sms_fallback && rule.primary_channel === 'whatsapp' ? first('sms') : null) || (rule.sms_fallback && rule.primary_channel === 'sms' ? first('whatsapp') : null) || endpoints.find((endpoint) => endpoint.channel !== excludedChannel) || null; }
function messageForDigest(memberCount, birthdayDate, daysBefore = 0) { const subject = memberCount === 1 ? '1 authorised birthday is due' : `${memberCount} authorised birthdays are due`; const timing = daysBefore === 0 ? `on ${prettyDate(birthdayDate)}` : `in ${daysBefore} day${daysBefore === 1 ? '' : 's'} (${prettyDate(birthdayDate)})`; return `${subject} ${timing}. Sign in to the Living Water private dashboard to view the permitted list.`; }
function messageForTest(channel) { return `Living Water Mega Parish: this is a ${channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} delivery test. No member data is included.`; }
function providerMode() { return process.env.MESSAGE_MODE || 'mock'; }
function normalizedProviderPhone(endpoint) { const phone = decryptValue(endpoint.phone_encrypted); return phone ? phone.replace(/\D/g, '') : null; }
function providerRequestTimeout() { return Math.min(30000, Math.max(3000, Number(process.env.PROVIDER_REQUEST_TIMEOUT_MS || 10000))); }
async function providerFetch(url, options) { return fetch(url, { ...options, signal: AbortSignal.timeout(providerRequestTimeout()) }); }

async function sendWithMeta(endpoint: DataRow, { memberCount }: ProviderDetails): Promise<ProviderDelivery> {
  const token = process.env.META_WHATSAPP_TOKEN; const phoneNumberId = process.env.META_PHONE_NUMBER_ID; const templateName = process.env.META_BIRTHDAY_TEMPLATE;
  if (!token || !phoneNumberId || !templateName) throw new Error('Meta WhatsApp production credentials/template are not configured. Keep MESSAGE_MODE=mock until they are available.');
  const response = await providerFetch(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}/${phoneNumberId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizedProviderPhone(endpoint), type: 'template', template: { name: templateName, language: { code: process.env.META_TEMPLATE_LANGUAGE || 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: String(memberCount || 0) }] }] } }) });
  const payload: any = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload?.error?.message || 'Meta WhatsApp API rejected the message.'); return { provider: 'meta', providerMessageId: payload?.messages?.[0]?.id || null, status: 'provider_accepted' };
}
async function sendWithTermii(endpoint: DataRow, content: string): Promise<ProviderDelivery> {
  const apiKey = process.env.TERMII_API_KEY; const senderId = process.env.TERMII_SENDER_ID; if (!apiKey || !senderId) throw new Error('Termii production credentials/sender ID are not configured. Keep MESSAGE_MODE=mock until they are available.');
  const response = await providerFetch(`${process.env.TERMII_BASE_URL || 'https://v3.api.termii.com'}/api/sms/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: apiKey, to: normalizedProviderPhone(endpoint), from: senderId, sms: content, channel: process.env.TERMII_SMS_CHANNEL || 'dnd', type: 'plain' }) });
  const payload: any = await response.json().catch(() => ({})); if (!response.ok || payload?.code === 'error') throw new Error(payload?.message || 'Termii rejected the SMS.'); return { provider: 'termii', providerMessageId: payload.message_id_str || payload.message_id || null, status: 'provider_accepted' };
}
async function sendMessage(endpoint: DataRow, content: string, details: ProviderDetails = {}): Promise<ProviderDelivery> { if (providerMode() === 'mock') return { provider: 'mock', providerMessageId: `${endpoint.channel === 'whatsapp' ? 'mock_wa_' : 'mock_sms_'}${crypto.randomUUID()}`, status: 'delivered', deliveredAt: nowIso() }; if (endpoint.channel === 'whatsapp') return sendWithMeta(endpoint, details); return sendWithTermii(endpoint, content); }
async function sendTermiiOtp(phone) { const apiKey = process.env.TERMII_API_KEY; const senderId = process.env.TERMII_SENDER_ID; if (!apiKey || !senderId) throw new Error('Termii OTP credentials/sender ID are not configured.'); const response = await providerFetch(`${process.env.TERMII_BASE_URL || 'https://v3.api.termii.com'}/api/sms/otp/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: apiKey, message_type: 'NUMERIC', to: String(phone).replace(/\D/g, ''), from: senderId, channel: process.env.TERMII_SMS_CHANNEL || 'dnd', pin_attempts: 5, pin_time_to_live: 10, pin_length: 6, pin_placeholder: '< 123456 >', message_text: 'Living Water verification code: < 123456 >. It expires in 10 minutes. Do not share this code.', pin_type: 'NUMERIC' }) }); const payload: any = await response.json().catch(() => ({})); const pinId = payload.pinId || payload.pin_id; if (!response.ok || payload?.code === 'error' || !pinId) throw new Error(payload?.message || 'Termii could not create the verification code.'); return { provider: 'termii_otp', providerMessageId: pinId, providerManaged: true, status: 'provider_accepted' }; }
export async function verifyTermiiOtp(pinId, code) { if (!process.env.TERMII_API_KEY || !pinId) return false; const response = await providerFetch(`${process.env.TERMII_BASE_URL || 'https://v3.api.termii.com'}/api/sms/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: process.env.TERMII_API_KEY, pin_id: pinId, pin: code }) }); const payload: any = await response.json().catch(() => ({})); return Boolean(response.ok && (payload.verified === true || String(payload.verified).toLowerCase() === 'true')); }
export async function sendEndpointVerificationSms(phone, code) { if (providerMode() !== 'mock' && process.env.TERMII_OTP_MODE !== 'local') return sendTermiiOtp(phone); return sendMessage({ channel: 'sms', phone_encrypted: encryptValue(phone) }, `Living Water verification code: ${code}. It expires in 10 minutes. Do not share this code.`, { type: 'endpoint_verification' }); }

async function insertNotification({ key, userId, endpointId, channel, scheduledFor, content, memberCount, type = 'birthday_digest' }) { return db.one(`INSERT INTO notifications (id, notification_key, user_id, endpoint_id, channel, notification_type, scheduled_for, message_preview, member_count, status, attempts, created_at, last_event_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?) ON CONFLICT(notification_key) DO NOTHING RETURNING *`, newId('notif_'), key, userId, endpointId, channel, type, scheduledFor, content, memberCount, nowIso(), nowIso()); }
async function attemptNotification(notification, endpoint, content, details) { const attemptedAt = nowIso(); await db.run(`UPDATE notifications SET attempts = attempts + 1, status = 'queued', last_event_at = ?, error_code = NULL, error_message = NULL WHERE id = ?`, attemptedAt, notification.id); try { const delivery = await sendMessage(endpoint, content, details); const sentAt = nowIso(); await db.run(`UPDATE notifications SET status = ?, provider = ?, provider_message_id = ?, sent_at = ?, delivered_at = ?, last_event_at = ? WHERE id = ?`, delivery.status, delivery.provider, delivery.providerMessageId, sentAt, delivery.deliveredAt || null, delivery.deliveredAt || sentAt, notification.id); return { ok: true, status: delivery.status, notificationId: notification.id }; } catch (error) { const message = error instanceof Error ? error.message : 'Unexpected provider error'; await db.run(`UPDATE notifications SET status = 'failed', error_code = 'PROVIDER_ERROR', error_message = ?, last_event_at = ? WHERE id = ?`, message.slice(0, 500), nowIso(), notification.id); return { ok: false, status: 'failed', notificationId: notification.id, error: message }; } }
async function queueSmsFallbackForFailedWhatsApp(notification) {
  if (notification.channel !== 'whatsapp' || notification.notification_type !== 'birthday_digest') return null;
  const rule = await getRule();
  if (!rule?.sms_fallback) return null;
  const user = await db.one('SELECT * FROM users WHERE id = ? AND active = TRUE', notification.user_id);
  const primaryEndpoint = await db.one('SELECT * FROM admin_endpoints WHERE id = ?', notification.endpoint_id);
  if (!user || !primaryEndpoint || primaryEndpoint.channel !== 'whatsapp') return null;
  const smsEndpoint = await selectEndpoint(user.id, rule, 'whatsapp');
  if (!smsEndpoint || smsEndpoint.channel !== 'sms') return null;
  const deliveryDate = parseIsoDate(notification.scheduled_for);
  if (!deliveryDate) return null;
  const birthdayDate = addCalendarDays(deliveryDate, Number(rule.days_before || 0));
  const content = messageForDigest(Number(notification.member_count), birthdayDate, Number(rule.days_before));
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
    actorId: 'system', actorName: 'Delivery worker', action: 'sms_fallback_queued', entityType: 'notification', entityId: fallback.id,
    summary: 'Queued SMS fallback after a WhatsApp birthday digest delivery failure.', metadata: { failedNotificationId: notification.id },
  });
  return { queued: true, notificationId: fallback.id };
}

export async function runBirthdayNotifications({ date: requestedDate = null, actor = null } = {}) {
  const deliveryDate = requestedDate ? parseIsoDate(requestedDate) : lagosDateParts();
  if (!deliveryDate) throw new Error('Use a valid ISO date such as 2026-08-31.');
  const rule = await getRule();
  if (!rule?.enabled) return { date: toIsoDate(deliveryDate), disabled: true, created: 0, skipped: 0, results: [] };
  const birthdayDate = addCalendarDays(deliveryDate, Number(rule.days_before || 0));
  const matchingMembers = await readEligibleMembers(birthdayDate);
  const recipients = await getRecipientUsers();
  const results = []; let created = 0; let skipped = 0;
  for (const user of recipients) {
    const visibleMembers = matchingMembers.filter((member) => isMemberVisibleToUser(member, user));
    if (!visibleMembers.length) { skipped += 1; continue; }
    const endpoint = await selectEndpoint(user.id, rule);
    if (!endpoint) { skipped += 1; continue; }
    const content = messageForDigest(visibleMembers.length, birthdayDate, Number(rule.days_before));
    const notification = await insertNotification({
      key: `birthday-digest:${toIsoDate(birthdayDate)}:lead-${rule.days_before}:${user.id}:${endpoint.channel}`,
      userId: user.id, endpointId: endpoint.id, channel: endpoint.channel,
      scheduledFor: toIsoDate(deliveryDate), content, memberCount: visibleMembers.length,
    });
    if (!notification) { skipped += 1; results.push({ userId: user.id, status: 'duplicate_suppressed' }); continue; }
    await queueOutboxJob('notification_delivery', { notificationId: notification.id });
    created += 1;
    results.push({ userId: user.id, channel: endpoint.channel, notificationId: notification.id, status: 'queued' });
  }
  await audit({
    actorId: actor?.id || 'system', actorName: actor?.fullName || 'Scheduler', action: 'birthday_digest_run', entityType: 'notification_rule', entityId: rule.id,
    summary: `Birthday digest evaluated for ${toIsoDate(deliveryDate)} against ${toIsoDate(birthdayDate)}: ${matchingMembers.length} eligible member(s), ${created} notification job(s) queued.`,
    metadata: { deliveryDate: toIsoDate(deliveryDate), birthdayDate: toIsoDate(birthdayDate), leadDays: Number(rule.days_before), matchingMembers: matchingMembers.length, created, skipped },
  });
  return { date: toIsoDate(deliveryDate), birthdayDate: toIsoDate(birthdayDate), leadDays: Number(rule.days_before), matchingMembers: matchingMembers.length, created, skipped, results };
}

export async function sendTestNotification(user) {
  const rule = await getRule(); const endpoint = await selectEndpoint(user.id, rule);
  if (!endpoint) throw new Error('No verified, opted-in notification endpoint is available for your account.');
  const scheduledFor = toIsoDate(lagosDateParts()); const content = messageForTest(endpoint.channel);
  const notification = await insertNotification({
    key: `test:${scheduledFor}:${user.id}:${endpoint.channel}:${crypto.randomUUID()}`,
    userId: user.id, endpointId: endpoint.id, channel: endpoint.channel, scheduledFor, content, memberCount: 0, type: 'test',
  });
  const deliveryJobId = await queueOutboxJob('notification_delivery', { notificationId: notification.id });
  // A test is explicitly requested by a signed-in user, so process its already-durable job now.
  await processOutboxJobs({ limit: 1, jobId: deliveryJobId });
  const finalNotification = await db.one('SELECT * FROM notifications WHERE id = ?', notification.id);
  await audit({
    actorId: user.id, actorName: user.fullName, action: 'test_notification_queued', entityType: 'notification', entityId: notification.id,
    summary: `Queued and attempted a ${endpoint.channel} test notification in ${providerMode()} mode.`,
  });
  return { ok: ['provider_accepted', 'sent', 'delivered', 'read'].includes(finalNotification?.status), status: finalNotification?.status || 'queued', notificationId: notification.id, channel: endpoint.channel, mode: providerMode() };
}

export async function queueOutboxJob(jobType, payload, dueAt = nowIso()) {
  const id = newId('job_'); const timestamp = nowIso();
  await db.run(`INSERT INTO outbox_jobs (id, job_type, payload, due_at, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`, id, jobType, JSON.stringify(payload), dueAt, timestamp, timestamp);
  return id;
}
function retryDueAt(attempts) {
  const delayMinutes = Math.min(30, 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delayMinutes * 60000).toISOString();
}
async function completeOutboxJob(id) { await db.run(`UPDATE outbox_jobs SET status = 'completed', updated_at = ?, last_error = NULL WHERE id = ?`, nowIso(), id); }
async function failOutboxJob(job, error) {
  const attempts = Number(job.attempts || 0) + 1;
  const terminal = attempts >= 5;
  await db.run(`UPDATE outbox_jobs SET status = ?, due_at = ?, last_error = ?, updated_at = ? WHERE id = ?`, terminal ? 'dead_letter' : 'failed', terminal ? nowIso() : retryDueAt(attempts), String(error?.message || error).slice(0, 500), nowIso(), job.id);
  if (terminal) await audit({ actorId: 'system', actorName: 'Delivery worker', action: 'outbox_job_dead_lettered', entityType: 'outbox_job', entityId: job.id, summary: `Delivery job exhausted five attempts: ${job.job_type}.`, metadata: { error: String(error?.message || error).slice(0, 250) } });
}
export async function processOutboxJobs({ limit = 25, jobId = null } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const lockingClause = process.env.DATABASE_URL === 'pgmem://' ? '' : ' FOR UPDATE SKIP LOCKED';
  const jobs = await db.transaction(async (tx) => {
    const jobFilter = jobId ? 'AND id = ?' : '';
    const params: any[] = [nowIso(), staleBefore];
    if (jobId) params.push(jobId);
    params.push(safeLimit);
    const claimed = await tx.all(`SELECT * FROM outbox_jobs WHERE (((status IN ('pending','failed')) AND due_at <= ?) OR (status = 'processing' AND updated_at <= ?)) ${jobFilter} AND attempts < 5 ORDER BY due_at ASC LIMIT ?${lockingClause}`, ...params);
    for (const job of claimed) await tx.run(`UPDATE outbox_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?`, nowIso(), job.id);
    return claimed;
  });
  for (const job of jobs) {
    try {
      if (job.job_type !== 'notification_delivery') throw new Error(`Unsupported outbox job type: ${job.job_type}`);
      const payload = JSON.parse(job.payload || '{}');
      const notification = payload.notificationId ? await db.one('SELECT * FROM notifications WHERE id = ?', payload.notificationId) : null;
      if (!notification) throw new Error('Notification referenced by delivery job no longer exists.');
      if (['provider_accepted', 'sent', 'delivered', 'read'].includes(notification.status)) { await completeOutboxJob(job.id); continue; }
      const endpoint = await db.one(`SELECT * FROM admin_endpoints WHERE id = ? AND enabled = TRUE AND verified_at IS NOT NULL AND opted_in_at IS NOT NULL AND opted_out_at IS NULL`, notification.endpoint_id);
      if (!endpoint) {
        await db.run(`UPDATE notifications SET status = 'failed', error_code = 'ENDPOINT_UNAVAILABLE', error_message = 'The verified notification endpoint is no longer available.', last_event_at = ? WHERE id = ?`, nowIso(), notification.id);
        await completeOutboxJob(job.id);
        continue;
      }
      const outcome = await attemptNotification(notification, endpoint, notification.message_preview, { memberCount: Number(notification.member_count), type: notification.notification_type });
      if (!outcome.ok) {
        const fallback = await queueSmsFallbackForFailedWhatsApp(notification);
        await audit({ actorId: 'system', actorName: 'Delivery worker', action: 'notification_delivery_failed', entityType: 'notification', entityId: notification.id, summary: 'A notification delivery attempt failed and will retry if eligible.', metadata: { fallbackQueued: Boolean(fallback?.queued), error: outcome.error } });
        throw new Error(outcome.error || 'Notification provider rejected the delivery.');
      }
      await completeOutboxJob(job.id);
    } catch (error) { await failOutboxJob(job, error); }
  }
  return jobs.length;
}

export async function listUserEndpoints(user, { revealPhone = false } = {}) { return (await db.all('SELECT * FROM admin_endpoints WHERE user_id = ? ORDER BY priority, created_at', user.id)).map((row) => endpointDto(row, { revealPhone })); }
export async function updateNotificationRule(values, user) { const rule = await getRule(); await db.run(`UPDATE notification_rules SET enabled = ?, digest_mode = ?, alert_time = ?, timezone = ?, days_before = ?, primary_channel = ?, sms_fallback = ?, feb29_policy = ?, updated_at = ?, updated_by = ? WHERE id = ?`, values.enabled, values.digestMode, values.alertTime, DEFAULT_TIMEZONE, values.daysBefore, values.primaryChannel, values.smsFallback, values.feb29Policy, nowIso(), user.id, rule.id); await audit({ actorId: user.id, actorName: user.fullName, action: 'notification_rule_updated', entityType: 'notification_rule', entityId: rule.id, summary: 'Updated daily birthday care notification settings.', metadata: { ...values } }); return getRule(); }
export async function getNotificationRuleDto() { const rule = await getRule(); return rule ? { id: rule.id, name: rule.name, enabled: Boolean(rule.enabled), digestMode: rule.digest_mode, alertTime: rule.alert_time, timezone: rule.timezone, daysBefore: Number(rule.days_before), primaryChannel: rule.primary_channel, smsFallback: Boolean(rule.sms_fallback), feb29Policy: rule.feb29_policy, updatedAt: rule.updated_at } : null; }
export async function applyProviderStatus({ provider, providerMessageId, status, eventHash, eventType }) {
  if (!eventHash) return { ignored: true };
  const result = await db.transaction(async (tx) => {
    const notification = providerMessageId ? await tx.one('SELECT * FROM notifications WHERE provider_message_id = ?', providerMessageId) : null;
    const event = await tx.one(`INSERT INTO provider_events (id, provider, event_hash, notification_id, event_type, payload_summary, received_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_hash) DO NOTHING RETURNING *`, newId('event_'), provider, eventHash, notification?.id || null, eventType, JSON.stringify({ providerMessageId, status }), nowIso());
    if (!event) return { duplicate: true };
    if (!notification) return { unmatched: true };
    const mapped = ['delivered','read','failed','sent','provider_accepted'].includes(status) ? status : 'provider_accepted';
    await tx.run(`UPDATE notifications SET status = ?, delivered_at = CASE WHEN ? IN ('delivered','read') THEN ? ELSE delivered_at END, read_at = CASE WHEN ? = 'read' THEN ? ELSE read_at END, last_event_at = ? WHERE id = ?`, mapped, mapped, nowIso(), mapped, nowIso(), nowIso(), notification.id);
    return { updated: true, notification, status: mapped };
  });
  if (!result.updated) return result;
  const fallback = result.status === 'failed' ? await queueSmsFallbackForFailedWhatsApp(result.notification) : null;
  return { updated: true, notificationId: result.notification.id, status: result.status, fallback };
}
