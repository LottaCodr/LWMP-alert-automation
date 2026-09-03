import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import { parse as parseCsv } from 'csv-parse/sync';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  acceptStaffInvitation,
  beginTotpEnrollment,
  confirmTotpEnrollment,
  createStaffInvitation,
  deactivateStaffAccount,
  findInvitation,
  getMfaStatus,
  hasEnrolledMfa,
  listStaffAccess,
  mfaMethodsForUser,
  publicInvitationDto,
  regenerateRecoveryCodes,
  revokeInvitation,
  useRecoveryCode,
  verifyTotpCode,
} from './auth-service.js';
import {
  audit,
  db,
  decryptValue,
  daysFromLagosToday,
  encryptValue,
  endpointDto,
  isValidMonthDay,
  lagosDateParts,
  lookupHash,
  memberDto,
  newId,
  nowIso,
  safeUser,
  toIsoDate,
} from './database.js';
import {
  applyProviderStatus,
  getNotificationRuleDto,
  listUserEndpoints,
  processOutboxJobs,
  queueOutboxJob,
  runBirthdayNotifications,
  sendEndpointVerificationSms,
  sendTestNotification,
  verifyTermiiOtp,
  updateNotificationRule,
} from './notification-service.js';

// The compiled runtime is emitted to build/server; static assets remain in the project client/dist directory.
const distDirectory = path.resolve(process.cwd(), 'client/dist');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'living-water-demo-session-secret-change-before-production';
const WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'living-water-demo-webhook-token';
const WEBHOOK_APP_SECRET = process.env.META_APP_SECRET || '';

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, message: string, code = 'REQUEST_ERROR', details: unknown = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const roleLabels = {
  owner: 'Organisation Owner',
  membership_officer: 'Membership Officer',
  birthday_coordinator: 'Birthday Coordinator',
  auditor: 'Auditor',
};

const app = express();
// Render terminates TLS at its proxy. Trust only the first proxy so secure session cookies work there.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: isProduction ? {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], connectSrc: ["'self'"], fontSrc: ["'self'"],
      formAction: ["'self'"], frameAncestors: ["'self'"], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"],
      scriptSrc: ["'self'"], styleSrc: ["'self'"], upgradeInsecureRequests: [],
    },
  } : false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({
  limit: '700kb',
  verify: (req, res, buffer) => {
    (req as express.Request).rawBody = buffer;
  },
}));
app.use(express.urlencoded({ extended: false, limit: '80kb' }));
app.use(session({
  name: 'lwmp.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8,
  },
}));

function issueCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

app.get('/api/auth/csrf', (req, res, next) => {
  try {
    const csrfToken = issueCsrfToken(req);
    return req.session.save((error) => error ? next(error) : res.json({ csrfToken }));
  } catch (error) { return next(error); }
});

app.use('/api', (req, res, next) => {
  const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const webhook = req.path === '/webhooks/whatsapp' || req.path === '/webhooks/sms';
  if (!unsafe || webhook) return next();
  const expected = req.session?.csrfToken;
  const supplied = req.get('x-csrf-token');
  const valid = expected && supplied && Buffer.byteLength(expected) === Buffer.byteLength(supplied)
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  if (!valid) return next(new ApiError(403, 'Your secure session token is missing or expired. Refresh the page and try again.', 'CSRF_INVALID'));
  return next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'LOGIN_RATE_LIMIT', message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' } },
});

const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'MFA_RATE_LIMIT', message: 'Too many verification attempts. Wait 15 minutes and try again.' } },
});

const endpointVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'ENDPOINT_VERIFICATION_RATE_LIMIT', message: 'Too many verification messages have been requested. Try again in an hour.' } },
});

function establishSession(req, user) {
  const csrfToken = req.session?.csrfToken || crypto.randomBytes(32).toString('base64url');
  return new Promise<void>((resolve, reject) => {
    req.session.regenerate((regenerateError) => {
      if (regenerateError) return reject(regenerateError);
      req.session.userId = user.id;
      req.session.csrfToken = csrfToken;
      req.session.authenticatedAt = nowIso();
      req.session.mfaSatisfiedAt = nowIso();
      return req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

function establishPreMfaSession(req, user) {
  const csrfToken = req.session?.csrfToken || crypto.randomBytes(32).toString('base64url');
  return new Promise<void>((resolve, reject) => {
    req.session.regenerate((regenerateError) => {
      if (regenerateError) return reject(regenerateError);
      req.session.preMfaUserId = user.id;
      req.session.preMfaStartedAt = nowIso();
      req.session.csrfToken = csrfToken;
      return req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });
}

function preMfaUser(req) {
  const startedAt = req.session?.preMfaStartedAt ? new Date(req.session.preMfaStartedAt).getTime() : 0;
  if (!req.session?.preMfaUserId || !startedAt || Date.now() - startedAt > 15 * 60 * 1000) return null;
  return getUserById(req.session.preMfaUserId);
}

function requireMfaSetup(req, res, next) {
  const user = req.session?.userId ? getUserById(req.session.userId) : preMfaUser(req);
  if (!user) return next(new ApiError(401, 'Start with your invitation or sign in before configuring MFA.', 'MFA_SETUP_AUTH_REQUIRED'));
  req.user = { ...safeUser(user), _row: user };
  return next();
}

function applicationBaseUrl(req) {
  const configured = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL;
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function webAuthnConfiguration(req) {
  const origin = process.env.WEBAUTHN_ORIGIN || applicationBaseUrl(req);
  let parsed;
  try { parsed = new URL(origin); } catch { throw new ApiError(503, 'The passkey origin is not configured correctly.', 'PASSKEY_CONFIGURATION_ERROR'); }
  const rpID = process.env.WEBAUTHN_RP_ID || parsed.hostname;
  if (isProduction && (!process.env.WEBAUTHN_ORIGIN || !process.env.WEBAUTHN_RP_ID)) {
    throw new ApiError(503, 'Passkeys are not ready yet. Configure WEBAUTHN_ORIGIN and WEBAUTHN_RP_ID in Render first.', 'PASSKEY_CONFIGURATION_REQUIRED');
  }
  if (parsed.protocol !== 'https:' && isProduction) {
    throw new ApiError(503, 'Passkeys require an HTTPS application origin.', 'PASSKEY_HTTPS_REQUIRED');
  }
  return { origin, rpID };
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id);
}

function requireAuth(req, res, next) {
  const user = req.session?.userId ? getUserById(req.session.userId) : null;
  if (!user) return next(new ApiError(401, 'Please sign in to continue.', 'AUTH_REQUIRED'));
  req.user = { ...safeUser(user), _row: user };
  return next();
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have permission to perform this action.', 'FORBIDDEN'));
    }
    return next();
  };
}

function canRevealPhone(user) {
  return ['owner', 'membership_officer'].includes(user.role);
}

function canViewMember(user, member) {
  if (['owner', 'membership_officer'].includes(user.role)) return true;
  if (user.role === 'birthday_coordinator') {
    return user.groupScope.length === 0 || user.groupScope.includes(member.ministry_group);
  }
  return false;
}

function cleanString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizePhone(value) {
  const parsed = parsePhoneNumberFromString(String(value || '').trim(), 'NG');
  if (!parsed || !parsed.isValid()) {
    throw new ApiError(422, 'Enter a valid mobile number. Nigerian numbers may be entered as 080… or +234….', 'INVALID_PHONE');
  }
  return parsed.number;
}

function nextMemberCode() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM members').get().count;
  return `LW-${String(1000 + count + 1)}`;
}

function assertDate(month, day) {
  if (!isValidMonthDay(month, day)) {
    throw new ApiError(422, 'The birthday month and day do not form a valid calendar date.', 'INVALID_BIRTHDAY');
  }
}

const memberSchema = z.object({
  firstName: z.string().trim().min(2, 'Enter a first name.').max(80),
  lastName: z.string().trim().min(2, 'Enter a last name.').max(80),
  preferredName: z.string().trim().max(80).nullable().optional(),
  phone: z.string().trim().min(7, 'Enter a valid phone number.').max(40),
  birthMonth: z.coerce.number().int().min(1).max(12),
  birthDay: z.coerce.number().int().min(1).max(31),
  birthYear: z.union([z.coerce.number().int().min(1900).max(new Date().getFullYear()), z.null()]).optional(),
  status: z.enum(['active', 'visitor', 'inactive', 'archived', 'deceased']).default('active'),
  ministryGroup: z.string().trim().min(2).max(80).default('General'),
  birthdayAlertAllowed: z.boolean().default(true),
  consentRecorded: z.boolean().default(false),
  confirmPotentialDuplicate: z.boolean().optional().default(false),
});

function parseMemberPayload(payload, { requireConsent = false } = {}) {
  const result = memberSchema.safeParse(payload);
  if (!result.success) {
    throw new ApiError(422, 'Please correct the highlighted member details.', 'INVALID_MEMBER', result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }
  const data = result.data;
  assertDate(data.birthMonth, data.birthDay);
  if (requireConsent && !data.consentRecorded) {
    throw new ApiError(422, 'Record the applicable membership/privacy basis before saving this person.', 'CONSENT_REQUIRED');
  }
  return {
    ...data,
    preferredName: data.preferredName || null,
    phone: normalizePhone(data.phone),
    birthYear: data.birthYear || null,
  };
}

function memberDuplicate(phoneHash, ignoreId = null) {
  let query = 'SELECT * FROM members WHERE phone_hash = ?';
  const params = [phoneHash];
  if (ignoreId) {
    query += ' AND id != ?';
    params.push(ignoreId);
  }
  return db.prepare(query).get(...params);
}

function makeMember(row, user) {
  return memberDto(row, { revealPhone: canRevealPhone(user) });
}

function createMember(data, user, { source = 'Member form' } = {}) {
  const phoneHash = lookupHash(data.phone);
  const possibleDuplicate = memberDuplicate(phoneHash);
  if (possibleDuplicate && !data.confirmPotentialDuplicate) {
    throw new ApiError(409, 'A record with this phone number may already exist. Review it before creating a duplicate.', 'DUPLICATE_CANDIDATE', {
      existing: memberDto(possibleDuplicate, { revealPhone: false }),
    });
  }
  const id = newId('mem_');
  const timestamp = nowIso();
  const code = nextMemberCode();
  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO members (
        id, member_code, first_name, last_name, preferred_name, phone_encrypted, phone_hash,
        birth_month, birth_day, birth_year, status, ministry_group, birthday_alert_allowed,
        consent_status, consent_at, privacy_notice_version, created_at, created_by, updated_at, updated_by, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, 'v1.0', ?, ?, ?, ?, ?)
    `).run(
      id, code, data.firstName, data.lastName, data.preferredName, encryptValue(data.phone), phoneHash,
      data.birthMonth, data.birthDay, data.birthYear, data.status, data.ministryGroup, data.birthdayAlertAllowed ? 1 : 0,
      timestamp, timestamp, user.id, timestamp, user.id, data.status === 'archived' ? timestamp : null,
    );
    db.prepare(`
      INSERT INTO consent_records (id, member_id, purpose, lawful_basis, action, source, notice_version, recorded_at, recorded_by, details)
      VALUES (?, ?, 'Membership care and birthday reminders', 'Recorded church membership purpose', 'recorded', ?, 'v1.0', ?, ?, ?)
    `).run(newId('consent_'), id, source, timestamp, user.id, 'Recorded during membership intake.');
    queueOutboxJob('member_birthday_recalculate', { memberId: id, reason: 'member_created' });
  });
  create();
  const row = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'member_created',
    entityType: 'member',
    entityId: id,
    summary: `Created member record ${code}.`,
    metadata: { group: data.ministryGroup, birthdayAlertAllowed: data.birthdayAlertAllowed },
  });
  return makeMember(row, user);
}

function updateMember(id, data, user) {
  const existing = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!existing) throw new ApiError(404, 'Member not found.', 'MEMBER_NOT_FOUND');
  const phoneHash = lookupHash(data.phone);
  const possibleDuplicate = memberDuplicate(phoneHash, id);
  if (possibleDuplicate && !data.confirmPotentialDuplicate) {
    throw new ApiError(409, 'A record with this phone number may already exist. Review it before saving.', 'DUPLICATE_CANDIDATE', {
      existing: memberDto(possibleDuplicate, { revealPhone: false }),
    });
  }
  const timestamp = nowIso();
  const update = db.transaction(() => {
    db.prepare(`
      UPDATE members
      SET first_name = ?, last_name = ?, preferred_name = ?, phone_encrypted = ?, phone_hash = ?,
          birth_month = ?, birth_day = ?, birth_year = ?, status = ?, ministry_group = ?, birthday_alert_allowed = ?,
          updated_at = ?, updated_by = ?, archived_at = ?
      WHERE id = ?
    `).run(
      data.firstName, data.lastName, data.preferredName, encryptValue(data.phone), phoneHash,
      data.birthMonth, data.birthDay, data.birthYear, data.status, data.ministryGroup, data.birthdayAlertAllowed ? 1 : 0,
      timestamp, user.id, data.status === 'archived' ? (existing.archived_at || timestamp) : null, id,
    );
    queueOutboxJob('member_birthday_recalculate', { memberId: id, reason: 'member_updated' });
  });
  update();
  audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'member_updated',
    entityType: 'member',
    entityId: id,
    summary: `Updated member record ${existing.member_code}.`,
    metadata: { group: data.ministryGroup, status: data.status, birthdayAlertAllowed: data.birthdayAlertAllowed },
  });
  return makeMember(db.prepare('SELECT * FROM members WHERE id = ?').get(id), user);
}

function datePartsFromIso(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return null;
  const [year, month, day] = iso.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

function birthdayMatchesDate(member, date, feb29Policy) {
  if (member.birth_month === date.month && member.birth_day === date.day) return true;
  if (member.birth_month !== 2 || member.birth_day !== 29) return false;
  const leap = date.year % 4 === 0 && (date.year % 100 !== 0 || date.year % 400 === 0);
  if (leap) return date.month === 2 && date.day === 29;
  return feb29Policy === 'mar1' ? date.month === 3 && date.day === 1 : date.month === 2 && date.day === 28;
}

function allowedBirthdayMembers(user, days = 14) {
  const rule = getNotificationRuleDto();
  const rows = db.prepare(`
    SELECT * FROM members
    WHERE status = 'active' AND birthday_alert_allowed = 1 AND consent_status != 'withdrawn'
  `).all();
  const matching = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = daysFromLagosToday(offset);
    for (const row of rows) {
      if (!birthdayMatchesDate(row, date, rule.feb29Policy) || !canViewMember(user, row)) continue;
      matching.push({
        ...memberDto(row, { revealPhone: false }),
        occurrenceDate: toIsoDate(date),
        daysUntil: offset,
      });
    }
  }
  return matching.sort((a, b) => a.daysUntil - b.daysUntil || a.fullName.localeCompare(b.fullName));
}

function notificationDto(row) {
  return {
    id: row.id,
    notificationKey: row.notification_key,
    userId: row.user_id,
    recipientName: row.recipient_name || 'Administrator',
    endpointLabel: row.endpoint_label || 'Notification endpoint',
    endpointMasked: row.phone_encrypted ? `•••• ${String(decryptValue(row.phone_encrypted) || '').slice(-4)}` : null,
    channel: row.channel,
    type: row.notification_type,
    scheduledFor: row.scheduled_for,
    messagePreview: row.message_preview,
    memberCount: row.member_count,
    status: row.status,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    attempts: row.attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    lastEventAt: row.last_event_at,
  };
}

function getNotifications(user, limit: string | number = 40) {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const where = user.role === 'owner' ? '' : 'WHERE n.user_id = ?';
  const query = `
    SELECT n.*, u.full_name AS recipient_name, endpoint.label AS endpoint_label, endpoint.phone_encrypted
    FROM notifications n
    INNER JOIN users u ON u.id = n.user_id
    INNER JOIN admin_endpoints endpoint ON endpoint.id = n.endpoint_id
    ${where}
    ORDER BY n.created_at DESC
    LIMIT ?
  `;
  const rows = user.role === 'owner'
    ? db.prepare(query).all(safeLimit)
    : db.prepare(query).all(user.id, safeLimit);
  return rows.map(notificationDto);
}

function dashboardFor(user) {
  const today = lagosDateParts();
  const todayIso = toIsoDate(today);
  const upcoming = allowedBirthdayMembers(user, 14);
  const todaysBirthdays = upcoming.filter((item) => item.daysUntil === 0);
  const activeMembers = db.prepare(`SELECT COUNT(*) AS count FROM members WHERE status = 'active'`).get().count;
  const dataHealth = db.prepare(`
    SELECT
      SUM(CASE WHEN phone_encrypted IS NULL THEN 1 ELSE 0 END) AS missing_phone,
      SUM(CASE WHEN consent_status = 'review_required' THEN 1 ELSE 0 END) AS review_required,
      SUM(CASE WHEN birthday_alert_allowed = 0 THEN 1 ELSE 0 END) AS suppressed
    FROM members WHERE status = 'active'
  `).get();
  const delivery = user.role === 'owner'
    ? db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('delivered','read') THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed
      FROM notifications
      WHERE created_at >= datetime('now', '-30 days')
    `).get()
    : db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('delivered','read') THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed
      FROM notifications
      WHERE user_id = ? AND created_at >= datetime('now', '-30 days')
    `).get(user.id);
  const total = Number(delivery.total || 0);
  const delivered = Number(delivery.delivered || 0);
  const rate = total ? Math.round((delivered / total) * 100) : null;
  return {
    date: todayIso,
    parish: JSON.parse(db.prepare(`SELECT setting_value FROM app_settings WHERE setting_key = 'parish_profile'`).get()?.setting_value || '{}'),
    rule: getNotificationRuleDto(),
    stats: {
      activeMembers,
      todaysBirthdays: todaysBirthdays.length,
      nextSevenDays: upcoming.filter((item) => item.daysUntil <= 7).length,
      deliveryRate: rate,
      failedDeliveries: Number(delivery.failed || 0),
      dataHealthIssues: Number(dataHealth.missing_phone || 0) + Number(dataHealth.review_required || 0),
    },
    todaysBirthdays,
    upcoming: upcoming.slice(0, 7),
    recentNotifications: getNotifications(user, 5),
  };
}

function verifyMetaSignature(req) {
  if (!WEBHOOK_APP_SECRET) return !isProduction;
  const signature = req.get('x-hub-signature-256');
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', WEBHOOK_APP_SECRET).update(req.rawBody || Buffer.from('')).digest('hex')}`;
  const provided = Buffer.from(signature);
  const actual = Buffer.from(expected);
  return provided.length === actual.length && crypto.timingSafeEqual(provided, actual);
}

function verifyTermiiSignature(req) {
  const secret = process.env.TERMII_WEBHOOK_SECRET;
  const signature = req.get('x-termii-signature');
  if (!secret) return !isProduction;
  if (!signature || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha512', secret).update(req.rawBody || Buffer.from('')).digest('hex');
  const provided = Buffer.from(signature.toLowerCase(), 'hex');
  const actual = Buffer.from(expected, 'hex');
  return provided.length === actual.length && crypto.timingSafeEqual(provided, actual);
}

function parseBirthdayString(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const ddMm = raw.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?$/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  if (ddMm) return { day: Number(ddMm[1]), month: Number(ddMm[2]), year: ddMm[3] ? Number(ddMm[3]) : null };
  return null;
}

function getField(row, ...names) {
  for (const name of names) {
    const hit = Object.keys(row).find((key) => key.toLowerCase().replace(/[ _-]/g, '') === name.toLowerCase().replace(/[ _-]/g, ''));
    if (hit && row[hit] !== undefined) return row[hit];
  }
  return undefined;
}

function unsafeCsvCell(value) {
  return /^[=+\-@]/.test(String(value || '').trim());
}

function parseImportRows(csvText) {
  if (typeof csvText !== 'string' || csvText.length < 5 || csvText.length > 450000) {
    throw new ApiError(422, 'Upload a CSV text file smaller than 450 KB.', 'INVALID_IMPORT');
  }
  let rows;
  try {
    rows = parseCsv(csvText, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: false });
  } catch (error) {
    throw new ApiError(422, `The CSV could not be read: ${error.message}`, 'INVALID_CSV');
  }
  if (rows.length > 500) throw new ApiError(422, 'Import no more than 500 rows at a time.', 'IMPORT_TOO_LARGE');
  return rows.map((row, index) => {
    const firstName = cleanString(getField(row, 'first_name', 'firstname', 'first name'));
    const lastName = cleanString(getField(row, 'last_name', 'lastname', 'last name'));
    const phone = cleanString(getField(row, 'phone', 'mobile', 'mobile_number', 'phone_number'));
    const group = cleanString(getField(row, 'ministry_group', 'group', 'ministry'), 'General');
    const birthMonthRaw = getField(row, 'birth_month', 'birthmonth');
    const birthDayRaw = getField(row, 'birth_day', 'birthdayday', 'birthday');
    const birthYearRaw = getField(row, 'birth_year', 'birthyear');
    const birthday = parseBirthdayString(getField(row, 'birthday', 'date_of_birth', 'dob'));
    const numberOrNull = (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : null;
    };
    const birthMonth = numberOrNull(birthMonthRaw) ?? birthday?.month ?? null;
    const birthDay = numberOrNull(birthDayRaw) ?? birthday?.day ?? null;
    const birthYear = numberOrNull(birthYearRaw) ?? birthday?.year ?? null;
    const errors = [];
    if ([firstName, lastName, phone, group].some(unsafeCsvCell)) errors.push('Formula-like values are not allowed in imported cells.');
    if (!firstName) errors.push('First name is required.');
    if (!lastName) errors.push('Last name is required.');
    let normalizedPhone = null;
    try { normalizedPhone = normalizePhone(phone); } catch { errors.push('Valid mobile phone is required.'); }
    if (!isValidMonthDay(birthMonth, birthDay)) errors.push('A valid birthday month/day or birthday date is required.');
    if (birthYear && (birthYear < 1900 || birthYear > new Date().getFullYear())) errors.push('Birth year is outside the accepted range.');
    const duplicate = normalizedPhone ? memberDuplicate(lookupHash(normalizedPhone)) : null;
    return {
      rowNumber: index + 2,
      firstName,
      lastName,
      preferredName: cleanString(getField(row, 'preferred_name', 'preferredname')) || null,
      phone: normalizedPhone,
      birthMonth,
      birthDay,
      birthYear,
      ministryGroup: group,
      status: 'active',
      birthdayAlertAllowed: true,
      valid: errors.length === 0,
      errors,
      duplicate: duplicate ? { memberCode: duplicate.member_code, fullName: `${duplicate.first_name} ${duplicate.last_name}` } : null,
    };
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'living-water-alerts', mode: process.env.MESSAGE_MODE || 'mock', time: nowIso() });
});

app.get('/api/auth/demo-accounts', (req, res) => {
  if (isProduction) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  return res.json({
    password: 'LivingWater@2026',
    accounts: db.prepare(`SELECT full_name, email, role FROM users WHERE active = 1 ORDER BY role, full_name`).all().map((row) => ({
      name: row.full_name,
      email: row.email,
      role: row.role,
      roleLabel: roleLabels[row.role],
    })),
  });
});

app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Enter your email address and password.', 'INVALID_LOGIN');
    const email = parsed.data.email.toLowerCase().trim();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    const passwordMatches = user ? await bcrypt.compare(parsed.data.password, user.password_hash) : false;
    if (!user || !passwordMatches) {
      audit({ actorName: 'Anonymous', action: 'login_failed', entityType: 'authentication', summary: 'A sign-in attempt failed.' });
      throw new ApiError(401, 'The email or password is incorrect.', 'INVALID_CREDENTIALS');
    }

    const mfaMethods = mfaMethodsForUser(user);
    if (mfaMethods.required) {
      await establishPreMfaSession(req, user);
      audit({ actorId: user.id, actorName: user.full_name, action: hasEnrolledMfa(user) ? 'password_verified_mfa_challenge' : 'password_verified_mfa_enrollment_required', entityType: 'authentication', entityId: user.id, summary: hasEnrolledMfa(user) ? 'Password accepted; MFA verification is required.' : 'Password accepted; initial MFA enrollment is required.' });
      return res.json({
        requiresMfa: true,
        enrollmentRequired: !hasEnrolledMfa(user),
        methods: mfaMethods,
        user: safeUser(user),
        demoMode: !isProduction,
      });
    }

    await establishSession(req, user);
    audit({ actorId: user.id, actorName: user.full_name, action: 'login_succeeded', entityType: 'authentication', entityId: user.id, summary: 'Signed in to the parish dashboard.' });
    return res.json({ user: safeUser(user), demoMode: !isProduction });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth, (req, res, next) => {
  const actor = req.user;
  req.session.destroy((error) => {
    if (error) return next(error);
    audit({ actorId: actor.id, actorName: actor.fullName, action: 'logout', entityType: 'authentication', entityId: actor.id, summary: 'Signed out of the parish dashboard.' });
    res.clearCookie('lwmp.sid');
    return res.status(204).end();
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user, demoMode: !isProduction, roleLabel: roleLabels[req.user.role] });
});

app.get('/api/invitations/:token', (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (token.length < 32) throw new ApiError(404, 'This staff invitation is not available.', 'INVITATION_NOT_FOUND');
    const invitation = findInvitation(token);
    if (!invitation) throw new ApiError(404, 'This staff invitation is invalid, expired, revoked, or already used.', 'INVITATION_NOT_FOUND');
    return res.json({ invitation: publicInvitationDto(invitation) });
  } catch (error) { return next(error); }
});

app.post('/api/invitations/:token/accept', loginLimiter, async (req, res, next) => {
  try {
    const passwordSchema = z.string().min(12, 'Use at least 12 characters.').max(128)
      .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value), 'Use upper-case, lower-case, and a number.');
    const parsed = z.object({ password: passwordSchema }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Choose a stronger password before creating your staff account.', 'WEAK_PASSWORD', parsed.error.issues);
    const user = await acceptStaffInvitation(String(req.params.token || ''), parsed.data.password);
    const rawUser = getUserById(user.id);
    await establishPreMfaSession(req, rawUser);
    return res.status(201).json({
      user,
      requiresMfa: true,
      enrollmentRequired: true,
      methods: mfaMethodsForUser(rawUser),
      message: 'Account created. Set up an authenticator app or passkey before entering the dashboard.',
    });
  } catch (error) { return next(error); }
});

app.get('/api/auth/mfa/status', requireMfaSetup, (req, res) => {
  const status = getMfaStatus(req.user.id);
  return res.json({ ...status, preMfaChallenge: Boolean(req.session?.preMfaUserId) });
});

app.post('/api/auth/mfa/totp/start', requireMfaSetup, async (req, res, next) => {
  try {
    const enrollment = await beginTotpEnrollment(req.user._row);
    return res.json({ enrollment });
  } catch (error) { return next(error); }
});

app.post('/api/auth/mfa/totp/confirm', requireMfaSetup, mfaLimiter, async (req, res, next) => {
  try {
    const parsed = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the six-digit code from your authenticator app.') }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Enter the six-digit code from your authenticator app.', 'INVALID_TOTP_CODE', parsed.error.issues);
    const result = await confirmTotpEnrollment(req.user._row, parsed.data.code);
    const refreshed = getUserById(req.user.id);
    if (req.session?.preMfaUserId) await establishSession(req, refreshed);
    return res.json({
      user: safeUser(refreshed),
      recoveryCodes: result.recoveryCodes,
      message: 'Authenticator app enrolled. Save the recovery codes somewhere safe now; they will not be shown again.',
    });
  } catch (error) { return next(error); }
});

app.post('/api/auth/mfa/verify', mfaLimiter, async (req, res, next) => {
  try {
    const user = preMfaUser(req);
    if (!user) throw new ApiError(401, 'Your MFA challenge has expired. Sign in again.', 'MFA_CHALLENGE_EXPIRED');
    const parsed = z.object({ method: z.enum(['totp', 'recovery']), code: z.string().trim().min(6).max(40) }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Enter your authenticator or recovery code.', 'INVALID_MFA_CODE', parsed.error.issues);
    const valid = parsed.data.method === 'totp'
      ? await verifyTotpCode(user, parsed.data.code)
      : useRecoveryCode(user.id, parsed.data.code);
    if (!valid) {
      audit({ actorId: user.id, actorName: user.full_name, action: 'mfa_verification_failed', entityType: 'authentication', entityId: user.id, summary: 'An MFA code verification failed.' });
      throw new ApiError(401, 'That verification code is not valid.', 'INVALID_MFA_CODE');
    }
    await establishSession(req, user);
    audit({ actorId: user.id, actorName: user.full_name, action: 'mfa_verification_succeeded', entityType: 'authentication', entityId: user.id, summary: `Completed ${parsed.data.method === 'totp' ? 'authenticator' : 'recovery code'} MFA verification.` });
    return res.json({ user: safeUser(user), demoMode: !isProduction });
  } catch (error) { return next(error); }
});

app.post('/api/auth/mfa/recovery-codes', requireAuth, mfaLimiter, async (req, res, next) => {
  try {
    const parsed = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter a current six-digit authenticator code.') }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Enter a current authenticator code.', 'INVALID_TOTP_CODE', parsed.error.issues);
    const recoveryCodes = await regenerateRecoveryCodes(req.user._row, parsed.data.code);
    return res.json({ recoveryCodes, message: 'New recovery codes have replaced all prior unused recovery codes.' });
  } catch (error) { return next(error); }
});

function saveRequestSession(req) {
  return new Promise<void>((resolve, reject) => req.session.save((error) => (error ? reject(error) : resolve())));
}

function validCeremony(ceremony) {
  return ceremony && new Date(ceremony.expiresAt).getTime() > Date.now();
}

function credentialForVerification(row) {
  return {
    id: row.credential_id,
    publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
    counter: Number(row.counter || 0),
    transports: JSON.parse(row.transports || '[]'),
  };
}

async function beginPasskeyAuthentication(req, user, ceremonyKey = 'passkeyAuthentication') {
  const credentials = db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at ASC').all(user.id);
  if (!credentials.length) throw new ApiError(422, 'No passkey is enrolled for this account. Use your authenticator app instead.', 'PASSKEY_NOT_ENROLLED');
  const { origin, rpID } = webAuthnConfiguration(req);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: credentials.map((credential) => ({ id: credential.credential_id, transports: JSON.parse(credential.transports || '[]') })),
    userVerification: 'required',
    timeout: 60000,
  });
  req.session[ceremonyKey] = { challenge: options.challenge, userId: user.id, origin, rpID, expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() };
  await saveRequestSession(req);
  return options;
}

async function completePasskeyAuthentication(req, response, ceremonyKey = 'passkeyAuthentication') {
  const ceremony = req.session?.[ceremonyKey];
  if (!validCeremony(ceremony)) throw new ApiError(401, 'This passkey request has expired. Start again.', 'PASSKEY_CHALLENGE_EXPIRED');
  const user = getUserById(ceremony.userId);
  if (!user) throw new ApiError(401, 'This staff account is no longer active.', 'AUTH_REQUIRED');
  const credentialId = String(response?.id || '');
  const passkey = db.prepare('SELECT * FROM passkeys WHERE credential_id = ? AND user_id = ?').get(credentialId, user.id);
  if (!passkey) throw new ApiError(401, 'This passkey is not recognised for the requested account.', 'PASSKEY_NOT_RECOGNISED');
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpID,
      credential: credentialForVerification(passkey),
      requireUserVerification: true,
    });
  } catch (error) {
    throw new ApiError(401, 'Passkey verification failed. Try again or use another sign-in method.', 'PASSKEY_VERIFICATION_FAILED');
  }
  if (!verification.verified) throw new ApiError(401, 'Passkey verification failed. Try again.', 'PASSKEY_VERIFICATION_FAILED');
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, nowIso(), passkey.id);
  return user;
}

app.post('/api/auth/passkey/options', loginLimiter, async (req, res, next) => {
  try {
    const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Enter the email address associated with your passkey.', 'INVALID_LOGIN');
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(parsed.data.email.trim().toLowerCase());
    if (!user) throw new ApiError(401, 'The requested passkey sign-in is not available.', 'PASSKEY_NOT_AVAILABLE');
    const options = await beginPasskeyAuthentication(req, user);
    return res.json({ options });
  } catch (error) { return next(error); }
});

app.post('/api/auth/passkey/verify', loginLimiter, async (req, res, next) => {
  try {
    const user = await completePasskeyAuthentication(req, req.body?.response);
    await establishSession(req, user);
    audit({ actorId: user.id, actorName: user.full_name, action: 'passkey_login_succeeded', entityType: 'authentication', entityId: user.id, summary: 'Signed in with a verified passkey.' });
    return res.json({ user: safeUser(user), demoMode: !isProduction });
  } catch (error) { return next(error); }
});

app.post('/api/auth/mfa/passkey/options', requireMfaSetup, mfaLimiter, async (req, res, next) => {
  try {
    if (!req.session?.preMfaUserId) throw new ApiError(409, 'Start with password sign-in before using a passkey as your second factor.', 'MFA_CHALLENGE_REQUIRED');
    const options = await beginPasskeyAuthentication(req, req.user._row, 'passkeyMfaAuthentication');
    return res.json({ options });
  } catch (error) { return next(error); }
});

app.post('/api/auth/mfa/passkey/verify', mfaLimiter, async (req, res, next) => {
  try {
    const user = await completePasskeyAuthentication(req, req.body?.response, 'passkeyMfaAuthentication');
    if (req.session?.preMfaUserId !== user.id) throw new ApiError(401, 'This passkey challenge does not match the sign-in request.', 'PASSKEY_VERIFICATION_FAILED');
    await establishSession(req, user);
    audit({ actorId: user.id, actorName: user.full_name, action: 'passkey_mfa_succeeded', entityType: 'authentication', entityId: user.id, summary: 'Completed MFA with a verified passkey.' });
    return res.json({ user: safeUser(user), demoMode: !isProduction });
  } catch (error) { return next(error); }
});

app.post('/api/auth/passkeys/registration/options', requireMfaSetup, async (req, res, next) => {
  try {
    const user = req.user._row;
    const credentials = db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at ASC').all(user.id);
    const { origin, rpID } = webAuthnConfiguration(req);
    const options = await generateRegistrationOptions({
      rpName: 'Living Water Mega Parish Birthday Care',
      rpID,
      userID: Buffer.from(user.id),
      userName: user.email,
      userDisplayName: user.full_name,
      attestationType: 'none',
      timeout: 60000,
      excludeCredentials: credentials.map((credential) => ({ id: credential.credential_id, transports: JSON.parse(credential.transports || '[]') })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    req.session.passkeyRegistration = { challenge: options.challenge, userId: user.id, origin, rpID, expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() };
    await saveRequestSession(req);
    return res.json({ options });
  } catch (error) { return next(error); }
});

app.post('/api/auth/passkeys/registration/verify', requireMfaSetup, async (req, res, next) => {
  try {
    const ceremony = req.session?.passkeyRegistration;
    if (!validCeremony(ceremony) || ceremony.userId !== req.user.id) throw new ApiError(401, 'This passkey enrollment request has expired. Start again.', 'PASSKEY_CHALLENGE_EXPIRED');
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: req.body?.response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: ceremony.origin,
        expectedRPID: ceremony.rpID,
        requireUserVerification: true,
      });
    } catch (error) {
      throw new ApiError(422, 'Passkey enrollment could not be verified. Try again.', 'PASSKEY_VERIFICATION_FAILED');
    }
    if (!verification.verified || !verification.registrationInfo) throw new ApiError(422, 'Passkey enrollment could not be verified. Try again.', 'PASSKEY_VERIFICATION_FAILED');
    const info = verification.registrationInfo;
    const timestamp = nowIso();
    const transports = Array.isArray(req.body?.response?.response?.transports) ? req.body.response.response.transports : [];
    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newId('passkey_'), req.user.id, info.credential.id,
          Buffer.from(info.credential.publicKey).toString('base64url'), info.credential.counter,
          JSON.stringify(transports), info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, timestamp,
        );
        db.prepare(`
          UPDATE users
          SET passkey_enrolled_at = COALESCE(passkey_enrolled_at, ?), mfa_required = 1, mfa_state = 'passkey_enrolled', updated_at = ?
          WHERE id = ?
        `).run(timestamp, timestamp, req.user.id);
      })();
    } catch (error) {
      if (String(error.message || '').includes('UNIQUE')) throw new ApiError(409, 'This passkey is already registered to a staff account.', 'PASSKEY_ALREADY_REGISTERED');
      throw error;
    }
    const user = getUserById(req.user.id);
    if (req.session?.preMfaUserId) await establishSession(req, user);
    audit({ actorId: user.id, actorName: user.full_name, action: 'passkey_enrollment_completed', entityType: 'authentication', entityId: user.id, summary: 'Enrolled a passkey for staff MFA.' });
    return res.status(201).json({ user: safeUser(user), message: 'Passkey enrolled successfully. It can now be used for secure sign-in.' });
  } catch (error) { return next(error); }
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  res.json(dashboardFor(req.user));
});

app.get('/api/members', requireAuth, requireRoles('owner', 'membership_officer'), (req, res) => {
  const search = cleanString(req.query.search);
  const status = cleanString(req.query.status);
  const group = cleanString(req.query.group);
  const params = [];
  const where = [];
  if (search) {
    where.push(`(LOWER(first_name || ' ' || last_name) LIKE ? OR LOWER(member_code) LIKE ?)`);
    const pattern = `%${search.toLowerCase()}%`;
    params.push(pattern, pattern);
  }
  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (group && group !== 'all') {
    where.push('ministry_group = ?');
    params.push(group);
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 20));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM members ${clause}`).get(...params).count;
  const rows = db.prepare(`SELECT * FROM members ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  const groups = db.prepare(`SELECT DISTINCT ministry_group AS name FROM members ORDER BY ministry_group`).all().map((item) => item.name);
  res.json({
    items: rows.map((row) => makeMember(row, req.user)),
    total,
    page,
    pageSize,
    groups,
  });
});

app.get('/api/members/:id', requireAuth, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    if (!row) throw new ApiError(404, 'Member not found.', 'MEMBER_NOT_FOUND');
    if (!canViewMember(req.user, row)) throw new ApiError(403, 'You are not permitted to view this member.', 'FORBIDDEN');
    res.json({ member: makeMember(row, req.user) });
  } catch (error) { next(error); }
});

app.post('/api/members', requireAuth, requireRoles('owner', 'membership_officer'), (req, res, next) => {
  try {
    const data = parseMemberPayload(req.body, { requireConsent: true });
    const member = createMember(data, req.user);
    processOutboxJobs();
    res.status(201).json({
      member,
      message: `Member saved. Birthday reminders are active; the next eligible alert will follow the parish rule.`,
    });
  } catch (error) { next(error); }
});

app.patch('/api/members/:id', requireAuth, requireRoles('owner', 'membership_officer'), (req, res, next) => {
  try {
    const data = parseMemberPayload({ ...req.body, consentRecorded: true });
    const member = updateMember(req.params.id, data, req.user);
    processOutboxJobs();
    res.json({ member, message: 'Member updated and birthday reminder data recalculated.' });
  } catch (error) { next(error); }
});

app.post('/api/members/:id/archive', requireAuth, requireRoles('owner', 'membership_officer'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
    if (!existing) throw new ApiError(404, 'Member not found.', 'MEMBER_NOT_FOUND');
    const timestamp = nowIso();
    db.prepare(`UPDATE members SET status = 'archived', archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ?`).run(timestamp, timestamp, req.user.id, existing.id);
    queueOutboxJob('member_birthday_recalculate', { memberId: existing.id, reason: 'member_archived' });
    audit({ actorId: req.user.id, actorName: req.user.fullName, action: 'member_archived', entityType: 'member', entityId: existing.id, summary: `Archived member record ${existing.member_code}.` });
    res.json({ message: 'Member archived. Future birthday alerts are suppressed.' });
  } catch (error) { next(error); }
});

app.get('/api/birthdays/today', requireAuth, requireRoles('owner', 'membership_officer', 'birthday_coordinator'), (req, res) => {
  const items = allowedBirthdayMembers(req.user, 0);
  res.json({ date: toIsoDate(lagosDateParts()), items });
});

app.get('/api/birthdays/upcoming', requireAuth, requireRoles('owner', 'membership_officer', 'birthday_coordinator'), (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  res.json({ items: allowedBirthdayMembers(req.user, days), days });
});

app.get('/api/notifications', requireAuth, (req, res) => {
  res.json({ items: getNotifications(req.user, String(req.query.limit || '')) });
});

app.post('/api/notifications/test', requireAuth, requireRoles('owner', 'membership_officer', 'birthday_coordinator'), async (req, res, next) => {
  try {
    const result = await sendTestNotification(req.user);
    res.status(201).json({ result, message: `Test ${result.channel} alert processed in ${result.mode} mode.` });
  } catch (error) { next(error); }
});

app.post('/api/notifications/run', requireAuth, requireRoles('owner'), async (req, res, next) => {
  try {
    const date = req.body?.date || toIsoDate(lagosDateParts());
    if (!datePartsFromIso(date)) throw new ApiError(422, 'Choose a valid date in YYYY-MM-DD format.', 'INVALID_RUN_DATE');
    const result = await runBirthdayNotifications({ date, actor: req.user });
    res.json({ result, message: `Birthday rule evaluated for ${date}. Duplicate delivery is automatically suppressed.` });
  } catch (error) { next(error); }
});

app.get('/api/settings', requireAuth, (req, res) => {
  const canManageRule = req.user.role === 'owner';
  res.json({
    rule: getNotificationRuleDto(),
    canManageRule,
    endpoints: listUserEndpoints(req.user, { revealPhone: true }),
    providerMode: process.env.MESSAGE_MODE || 'mock',
  });
});

const ruleSchema = z.object({
  enabled: z.boolean(),
  digestMode: z.literal('daily_digest'),
  alertTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 07:30.'),
  daysBefore: z.coerce.number().int().min(0).max(14),
  primaryChannel: z.enum(['whatsapp', 'sms']),
  smsFallback: z.boolean(),
  feb29Policy: z.enum(['feb28', 'mar1']),
});

app.put('/api/settings/rule', requireAuth, requireRoles('owner'), (req, res, next) => {
  try {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Check the notification rule values.', 'INVALID_RULE', parsed.error.issues);
    const rule = updateNotificationRule(parsed.data, req.user);
    res.json({ rule: {
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
    } });
  } catch (error) { next(error); }
});

const endpointCreateSchema = z.object({
  channel: z.enum(['whatsapp', 'sms']),
  phone: z.string().min(7).max(40),
  label: z.string().trim().min(2).max(80),
  priority: z.coerce.number().int().min(1).max(10).default(1),
  optInConfirmed: z.literal(true, { error: 'Confirm that this staff member has expressly opted in to this alert channel.' }),
});

function endpointCanBeManagedBy(endpoint, user) {
  return endpoint.user_id === user.id || user.role === 'owner';
}

async function requestEndpointVerification(endpoint, actor) {
  const phone = decryptValue(endpoint.phone_encrypted);
  if (!phone) throw new ApiError(422, 'This endpoint has no usable phone number.', 'ENDPOINT_PHONE_UNAVAILABLE');
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const code = String(crypto.randomInt(100000, 1000000));
  const verificationId = newId('endpoint_verify_');
  db.transaction(() => {
    db.prepare('DELETE FROM endpoint_verifications WHERE endpoint_id = ? AND consumed_at IS NULL').run(endpoint.id);
    db.prepare(`
      INSERT INTO endpoint_verifications (id, endpoint_id, code_hash, purpose, delivery_channel, provider, provider_message_id, requested_at, expires_at, attempts)
      VALUES (?, ?, ?, 'endpoint_ownership', 'sms', NULL, NULL, ?, ?, 0)
    `).run(verificationId, endpoint.id, lookupHash(`endpoint-verification:${endpoint.id}:${code}`), timestamp, expiresAt);
  })();
  try {
    const delivery = await sendEndpointVerificationSms(phone, code);
    db.prepare('UPDATE endpoint_verifications SET provider = ?, provider_message_id = ? WHERE id = ?').run(delivery.provider || null, delivery.providerMessageId || null, verificationId);
    audit({ actorId: actor.id, actorName: actor.fullName, action: 'endpoint_verification_requested', entityType: 'admin_endpoint', entityId: endpoint.id, summary: `Sent an SMS ownership verification challenge for a ${endpoint.channel} endpoint.`, metadata: { provider: delivery.provider, channel: endpoint.channel } });
    return {
      expiresAt,
      deliveryMode: process.env.MESSAGE_MODE || 'mock',
      debugCode: !isProduction && (process.env.MESSAGE_MODE || 'mock') === 'mock' ? code : undefined,
    };
  } catch (error) {
    db.prepare('DELETE FROM endpoint_verifications WHERE id = ?').run(verificationId);
    throw new ApiError(503, `Could not send the verification SMS. ${error.message || ''}`.trim(), 'ENDPOINT_VERIFICATION_SEND_FAILED');
  }
}

app.post('/api/endpoints', requireAuth, requireRoles('owner', 'membership_officer', 'birthday_coordinator'), endpointVerificationLimiter, async (req, res, next) => {
  try {
    const parsed = endpointCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Enter a valid notification endpoint and record its opt-in.', 'INVALID_ENDPOINT', parsed.error.issues);
    const data = parsed.data;
    const phone = normalizePhone(data.phone);
    const timestamp = nowIso();
    const id = newId('endpoint_');
    db.prepare(`
      INSERT INTO admin_endpoints (id, user_id, channel, phone_encrypted, phone_hash, label, priority, enabled, verified_at, opted_in_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
    `).run(id, req.user.id, data.channel, encryptValue(phone), lookupHash(phone), data.label, data.priority, timestamp, timestamp, timestamp);
    const rawEndpoint = db.prepare('SELECT * FROM admin_endpoints WHERE id = ?').get(id);
    audit({ actorId: req.user.id, actorName: req.user.fullName, action: 'admin_endpoint_added', entityType: 'admin_endpoint', entityId: id, summary: `Added a ${data.channel} notification endpoint awaiting ownership verification.`, metadata: { optInRecordedAt: timestamp } });
    const verification = await requestEndpointVerification(rawEndpoint, req.user);
    const endpoint = endpointDto(rawEndpoint, { revealPhone: true });
    return res.status(201).json({ endpoint, verification, message: 'Consent was recorded. Enter the SMS code to prove the number is controlled before alerts can be sent.' });
  } catch (error) { return next(error); }
});

app.post('/api/endpoints/:id/verification/resend', requireAuth, requireRoles('owner', 'membership_officer', 'birthday_coordinator'), endpointVerificationLimiter, async (req, res, next) => {
  try {
    const endpoint = db.prepare('SELECT * FROM admin_endpoints WHERE id = ?').get(req.params.id);
    if (!endpoint) throw new ApiError(404, 'Notification endpoint not found.', 'ENDPOINT_NOT_FOUND');
    if (!endpointCanBeManagedBy(endpoint, req.user)) throw new ApiError(403, 'You can only verify your own notification endpoints.', 'FORBIDDEN');
    if (endpoint.verified_at) throw new ApiError(409, 'This endpoint is already verified.', 'ENDPOINT_ALREADY_VERIFIED');
    const verification = await requestEndpointVerification(endpoint, req.user);
    return res.json({ verification, message: 'A fresh verification code was sent by SMS.' });
  } catch (error) { return next(error); }
});

app.post('/api/endpoints/:id/verification/confirm', requireAuth, requireRoles('owner', 'membership_officer', 'birthday_coordinator'), mfaLimiter, async (req, res, next) => {
  try {
    const endpoint = db.prepare('SELECT * FROM admin_endpoints WHERE id = ?').get(req.params.id);
    if (!endpoint) throw new ApiError(404, 'Notification endpoint not found.', 'ENDPOINT_NOT_FOUND');
    if (!endpointCanBeManagedBy(endpoint, req.user)) throw new ApiError(403, 'You can only verify your own notification endpoints.', 'FORBIDDEN');
    if (endpoint.verified_at) return res.json({ endpoint: endpointDto(endpoint, { revealPhone: true }), message: 'This endpoint is already verified.' });
    const parsed = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the six-digit SMS code.') }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Enter the six-digit SMS verification code.', 'INVALID_ENDPOINT_CODE', parsed.error.issues);
    const verification = db.prepare(`
      SELECT * FROM endpoint_verifications
      WHERE endpoint_id = ? AND consumed_at IS NULL
      ORDER BY requested_at DESC LIMIT 1
    `).get(endpoint.id);
    if (!verification || new Date(verification.expires_at).getTime() < Date.now()) throw new ApiError(410, 'This code has expired. Request a new verification code.', 'ENDPOINT_CODE_EXPIRED');
    if (verification.attempts >= 5) throw new ApiError(429, 'Too many attempts for this code. Request a fresh verification code.', 'ENDPOINT_CODE_LOCKED');
    db.prepare('UPDATE endpoint_verifications SET attempts = attempts + 1 WHERE id = ?').run(verification.id);
    const codeMatches = verification.provider === 'termii_otp'
      ? await verifyTermiiOtp(verification.provider_message_id, parsed.data.code)
      : crypto.timingSafeEqual(
        Buffer.from(lookupHash(`endpoint-verification:${endpoint.id}:${parsed.data.code}`)),
        Buffer.from(verification.code_hash),
      );
    if (!codeMatches) throw new ApiError(401, 'That verification code is not correct.', 'INVALID_ENDPOINT_CODE');
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare('UPDATE endpoint_verifications SET consumed_at = ? WHERE id = ?').run(timestamp, verification.id);
      db.prepare('UPDATE admin_endpoints SET verified_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, endpoint.id);
    })();
    const verifiedEndpoint = db.prepare('SELECT * FROM admin_endpoints WHERE id = ?').get(endpoint.id);
    audit({ actorId: req.user.id, actorName: req.user.fullName, action: 'endpoint_ownership_verified', entityType: 'admin_endpoint', entityId: endpoint.id, summary: `Verified ownership of a ${endpoint.channel} notification endpoint.`, metadata: { consentRecordedAt: endpoint.opted_in_at } });
    return res.json({ endpoint: endpointDto(verifiedEndpoint, { revealPhone: true }), message: 'Endpoint verified. It is now eligible for the parish notification rule.' });
  } catch (error) { return next(error); }
});

app.patch('/api/endpoints/:id', requireAuth, requireRoles('owner', 'membership_officer', 'birthday_coordinator'), (req, res, next) => {
  try {
    const endpoint = db.prepare('SELECT * FROM admin_endpoints WHERE id = ?').get(req.params.id);
    if (!endpoint) throw new ApiError(404, 'Notification endpoint not found.', 'ENDPOINT_NOT_FOUND');
    if (endpoint.user_id !== req.user.id && req.user.role !== 'owner') throw new ApiError(403, 'You can only update your own notification endpoints.', 'FORBIDDEN');
    const parsed = z.object({ enabled: z.boolean().optional(), priority: z.coerce.number().int().min(1).max(10).optional() }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Check the endpoint settings.', 'INVALID_ENDPOINT', parsed.error.issues);
    const data = parsed.data;
    db.prepare(`UPDATE admin_endpoints SET enabled = COALESCE(?, enabled), priority = COALESCE(?, priority), updated_at = ? WHERE id = ?`).run(
      typeof data.enabled === 'boolean' ? (data.enabled ? 1 : 0) : null,
      data.priority ?? null,
      nowIso(),
      endpoint.id,
    );
    audit({ actorId: req.user.id, actorName: req.user.fullName, action: 'admin_endpoint_updated', entityType: 'admin_endpoint', entityId: endpoint.id, summary: 'Updated notification endpoint preferences.' });
    res.json({ endpoint: endpointDto(db.prepare('SELECT * FROM admin_endpoints WHERE id = ?').get(endpoint.id), { revealPhone: true }) });
  } catch (error) { next(error); }
});

const staffInvitationSchema = z.object({
  fullName: z.string().trim().min(3, 'Enter the staff member’s full name.').max(120),
  email: z.string().trim().email('Enter a valid staff email address.'),
  role: z.enum(['owner', 'membership_officer', 'birthday_coordinator', 'auditor']),
  groupScope: z.array(z.string().trim().min(2).max(80)).max(30).default([]),
});

app.get('/api/staff/access', requireAuth, requireRoles('owner'), (req, res) => {
  return res.json(listStaffAccess());
});

app.post('/api/staff/invitations', requireAuth, requireRoles('owner'), async (req, res, next) => {
  try {
    const parsed = staffInvitationSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(422, 'Check the staff invitation details.', 'INVALID_STAFF_INVITATION', parsed.error.issues);
    const payload = { ...parsed.data, groupScope: [...new Set(parsed.data.groupScope)] };
    const result = await createStaffInvitation(payload, req.user, applicationBaseUrl(req));
    const message = result.delivery.status === 'delivered'
      ? 'Staff invitation created and email delivery was accepted.'
      : 'Staff invitation was created, but email delivery failed. Check the configured email provider before inviting again.';
    return res.status(201).json({ ...result, message });
  } catch (error) { return next(error); }
});

app.post('/api/staff/invitations/:id/revoke', requireAuth, requireRoles('owner'), (req, res, next) => {
  try {
    revokeInvitation(req.params.id, req.user);
    return res.status(204).end();
  } catch (error) { return next(error); }
});

app.post('/api/staff/:id/deactivate', requireAuth, requireRoles('owner'), (req, res, next) => {
  try {
    deactivateStaffAccount(req.params.id, req.user);
    return res.status(204).end();
  } catch (error) { return next(error); }
});

app.post('/api/imports/preview', requireAuth, requireRoles('owner', 'membership_officer'), (req, res, next) => {
  try {
    const rows = parseImportRows(req.body?.csvText);
    const valid = rows.filter((row) => row.valid && !row.duplicate).length;
    res.json({
      rows,
      summary: {
        total: rows.length,
        ready: valid,
        invalid: rows.filter((row) => !row.valid).length,
        duplicates: rows.filter((row) => row.duplicate).length,
      },
    });
  } catch (error) { next(error); }
});

app.post('/api/imports/commit', requireAuth, requireRoles('owner', 'membership_officer'), (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length || rows.length > 500) throw new ApiError(422, 'Select between 1 and 500 validated rows to import.', 'INVALID_IMPORT_COMMIT');
    let imported = 0;
    const rejected = [];
    const transaction = db.transaction(() => {
      for (const item of rows) {
        if (!item?.valid || item?.duplicate) {
          rejected.push({ rowNumber: item?.rowNumber, reason: 'Row is invalid or a duplicate candidate.' });
          continue;
        }
        try {
          const data = parseMemberPayload({ ...item, consentRecorded: true, confirmPotentialDuplicate: false }, { requireConsent: true });
          createMember(data, req.user, { source: 'Reviewed CSV import' });
          imported += 1;
        } catch (error) {
          rejected.push({ rowNumber: item?.rowNumber, reason: error.message });
        }
      }
    });
    transaction();
    processOutboxJobs();
    audit({ actorId: req.user.id, actorName: req.user.fullName, action: 'members_imported', entityType: 'import', summary: `Committed reviewed CSV import: ${imported} member(s) created, ${rejected.length} skipped.`, metadata: { imported, rejected: rejected.length } });
    res.status(201).json({ imported, rejected, message: `${imported} member record(s) imported. No raw CSV was retained by the server.` });
  } catch (error) { next(error); }
});

app.get('/api/audit', requireAuth, requireRoles('owner', 'auditor'), (req, res) => {
  const limit = Math.min(150, Math.max(10, Number(req.query.limit) || 80));
  const rows = db.prepare(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?`).all(limit).map((row) => ({
    id: row.id,
    actorName: row.actor_name,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    createdAt: row.created_at,
  }));
  res.json({ items: rows });
});

// Meta webhook verification handshake.
app.get('/api/webhooks/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  return res.sendStatus(403);
});

app.post('/api/webhooks/whatsapp', (req, res, next) => {
  try {
    if (!verifyMetaSignature(req)) throw new ApiError(401, 'Webhook signature verification failed.', 'INVALID_WEBHOOK_SIGNATURE');
    const statuses = req.body?.entry?.flatMap((entry) => entry.changes || [])
      .flatMap((change) => change?.value?.statuses || []) || [];
    for (const status of statuses) {
      const eventHash = crypto.createHash('sha256').update(JSON.stringify(status)).digest('hex');
      applyProviderStatus({
        provider: 'meta',
        providerMessageId: status.id,
        status: status.status,
        eventHash,
        eventType: 'whatsapp_status',
      });
    }
    return res.sendStatus(200);
  } catch (error) { return next(error); }
});

app.post('/api/webhooks/sms', (req, res, next) => {
  try {
    if (!verifyTermiiSignature(req)) {
      throw new ApiError(401, 'Termii webhook signature verification failed.', 'INVALID_WEBHOOK_SIGNATURE');
    }
    const providerMessageId = req.body?.message_id || req.body?.message_id_str || req.body?.id;
    const rawStatus = String(req.body?.status || '').toLowerCase();
    const status = rawStatus.includes('deliver') ? 'delivered' : /fail|dnd|reject|expired/.test(rawStatus) ? 'failed' : rawStatus.includes('sent') ? 'sent' : 'provider_accepted';
    const eventHash = crypto.createHash('sha256').update(req.rawBody || Buffer.from(JSON.stringify(req.body))).digest('hex');
    applyProviderStatus({ provider: 'termii', providerMessageId, status, eventHash, eventType: 'sms_delivery_report' });
    return res.sendStatus(200);
  } catch (error) { return next(error); }
});

app.use('/api', (req, res, next) => next(new ApiError(404, 'API endpoint not found.', 'API_NOT_FOUND')));

if (fs.existsSync(distDirectory)) {
  app.use(express.static(distDirectory, { index: false, maxAge: isProduction ? '1h' : 0 }));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(distDirectory, 'index.html')));
} else {
  app.get('/{*splat}', (req, res) => res.status(503).send('Frontend has not been built. Run npm run build first.'));
}

app.use((error, req, res, next) => {
  const status = error instanceof ApiError ? error.status : 500;
  const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof ApiError ? error.message : 'An unexpected error occurred.';
  if (!(error instanceof ApiError)) console.error(error);
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: { code, message, details: error instanceof ApiError ? error.details : undefined } });
  }
  return res.status(status).send(message);
});

function lagosClock() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('hour')}:${get('minute')}`;
}

if (process.env.SCHEDULER_ENABLED !== 'false') {
  // Runs every minute so the Organisation Owner can safely change the configured time in Settings.
  // The unique notification key is the cross-worker idempotency guard when the service is scaled.
  cron.schedule('* * * * *', async () => {
    const rule = getNotificationRuleDto();
    if (!rule?.enabled || lagosClock() !== rule.alertTime) return;
    try {
      const result = await runBirthdayNotifications();
      console.log(`[scheduler] birthday evaluation complete: ${result.created} created, ${result.skipped} skipped`);
    } catch (error) {
      console.error('[scheduler] birthday evaluation failed', error);
    }
  }, { timezone: 'Africa/Lagos', noOverlap: true });

  setInterval(() => processOutboxJobs(), 60_000).unref();
}

app.listen(port, host, () => {
  console.log(`Living Water Alerts is listening on http://${host}:${port}`);
  console.log(`Messaging mode: ${process.env.MESSAGE_MODE || 'mock'} | Birthday schedule: settings-controlled daily run in Africa/Lagos`);
  if (!isProduction) console.log('Demo credentials are available on the sign-in screen. Do not use demo configuration in production.');
});
