import { z } from 'zod';
import { ApiError } from '../errors.js';
import { audit, db, decryptValue, encryptValue, lookupHash, memberDto, newId, nowIso } from '../database-pg.js';
import { birthdayMatchesDate, daysFromLagosToday, isValidMonthDay, toIsoDate } from '../domain/calendar.js';
import { normalizeNigerianPhone } from '../domain/phone.js';
import { getNotificationRuleDto } from '../notification-pg.js';
import { canRevealPhone, canViewMember } from '../http/guards.js';
import type {
  CountRow,
  Feb29Policy,
  MemberDto,
  MemberRow,
  MemberStatus,
  SafeUser,
  UpcomingBirthdayDto,
} from '../types.js';

const memberStatusSchema = z.enum(['active', 'visitor', 'inactive', 'archived', 'deceased']);

export const memberSchema = z.object({
  firstName: z.string().trim().min(2).max(80),
  lastName: z.string().trim().min(2).max(80),
  preferredName: z.string().trim().max(80).nullable().optional(),
  phone: z.string().trim().min(7).max(40),
  birthMonth: z.coerce.number().int().min(1).max(12),
  birthDay: z.coerce.number().int().min(1).max(31),
  birthYear: z.union([z.coerce.number().int().min(1900).max(new Date().getFullYear()), z.null()]).optional(),
  status: memberStatusSchema.default('active'),
  ministryGroup: z.string().trim().min(2).max(80).default('General'),
  birthdayAlertAllowed: z.boolean().default(true),
  consentRecorded: z.boolean().default(false),
  confirmPotentialDuplicate: z.boolean().optional().default(false),
});

export interface MemberInput {
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
  confirmPotentialDuplicate: boolean;
}

export interface ParseOptions {
  requireConsent?: boolean;
}

export function parseMemberPayload(payload: unknown, { requireConsent = false }: ParseOptions = {}): MemberInput {
  const result = memberSchema.safeParse(payload);
  if (!result.success) {
    throw ApiError.unprocessable(
      'Please correct the highlighted member details.',
      'INVALID_MEMBER',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  const data = result.data;
  if (!isValidMonthDay(data.birthMonth, data.birthDay)) {
    throw ApiError.unprocessable('The birthday month and day do not form a valid calendar date.', 'INVALID_BIRTHDAY');
  }
  if (requireConsent && !data.consentRecorded) {
    throw ApiError.unprocessable(
      'Record the applicable membership/privacy basis before saving this person.',
      'CONSENT_REQUIRED',
    );
  }
  const phone = normalizeNigerianPhone(data.phone);
  if (!phone) {
    throw ApiError.unprocessable(
      'Enter a valid mobile number. Nigerian numbers may be entered as 080… or +234….',
      'INVALID_PHONE',
    );
  }
  return {
    ...data,
    preferredName: data.preferredName ?? null,
    phone,
    birthYear: data.birthYear ?? null,
  };
}

async function nextMemberCode(): Promise<string> {
  const row = await db.one<{ number: number }>("SELECT nextval('member_code_sequence')::int AS number");
  if (!row) throw ApiError.unavailable('Member code sequence is unavailable.');
  return `LW-${String(row.number)}`;
}

export async function findMemberById(id: string): Promise<MemberRow | null> {
  return db.one<MemberRow>('SELECT * FROM members WHERE id = ?', id);
}

async function memberDuplicate(phoneHash: string, ignoreId: string | null = null): Promise<MemberRow | null> {
  return ignoreId
    ? db.one<MemberRow>('SELECT * FROM members WHERE phone_hash = ? AND id != ?', phoneHash, ignoreId)
    : db.one<MemberRow>('SELECT * FROM members WHERE phone_hash = ?', phoneHash);
}

export function toMemberDto(row: MemberRow, user: SafeUser): MemberDto {
  return memberDto(row, { revealPhone: canRevealPhone(user) });
}

export interface CreateMemberOptions {
  source?: string;
}

export async function createMember(
  data: MemberInput,
  user: SafeUser,
  { source = 'Member form' }: CreateMemberOptions = {},
): Promise<MemberDto> {
  const phoneHash = lookupHash(data.phone);
  const duplicate = await memberDuplicate(phoneHash);
  if (duplicate && !data.confirmPotentialDuplicate) {
    throw ApiError.conflict(
      'A record with this phone number may already exist. Review it before creating a duplicate.',
      'DUPLICATE_CANDIDATE',
      { existing: memberDto(duplicate, { revealPhone: false }) },
    );
  }

  const id = newId('mem_');
  const timestamp = nowIso();
  const code = await nextMemberCode();

  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO members (id, member_code, first_name, last_name, preferred_name, phone_encrypted, phone_hash, birth_month, birth_day, birth_year, status, ministry_group, birthday_alert_allowed, consent_status, consent_at, privacy_notice_version, created_at, created_by, updated_at, updated_by, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, 'v1.0', ?, ?, ?, ?, ?)`,
      id,
      code,
      data.firstName,
      data.lastName,
      data.preferredName,
      encryptValue(data.phone),
      phoneHash,
      data.birthMonth,
      data.birthDay,
      data.birthYear,
      data.status,
      data.ministryGroup,
      data.birthdayAlertAllowed,
      timestamp,
      timestamp,
      user.id,
      timestamp,
      user.id,
      data.status === 'archived' ? timestamp : null,
    );
    await tx.run(
      `INSERT INTO consent_records (id, member_id, purpose, lawful_basis, action, source, notice_version, recorded_at, recorded_by, details)
       VALUES (?, ?, 'Membership care and birthday reminders', 'Recorded church membership purpose', 'recorded', ?, 'v1.0', ?, ?, ?)`,
      newId('consent_'),
      id,
      source,
      timestamp,
      user.id,
      'Recorded during membership intake.',
    );
  });

  await audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'member_created',
    entityType: 'member',
    entityId: id,
    summary: `Created member record ${code}.`,
  });

  const saved = await findMemberById(id);
  if (!saved) throw ApiError.notFound('Member could not be re-read after creation.', 'MEMBER_NOT_FOUND');
  return toMemberDto(saved, user);
}

export async function updateMember(id: string, data: MemberInput, user: SafeUser): Promise<MemberDto> {
  const existing = await findMemberById(id);
  if (!existing) throw ApiError.notFound('Member not found.', 'MEMBER_NOT_FOUND');

  const phoneHash = lookupHash(data.phone);
  const duplicate = await memberDuplicate(phoneHash, id);
  if (duplicate && !data.confirmPotentialDuplicate) {
    throw ApiError.conflict(
      'A record with this phone number may already exist. Review it before saving.',
      'DUPLICATE_CANDIDATE',
      { existing: memberDto(duplicate, { revealPhone: false }) },
    );
  }

  const timestamp = nowIso();
  await db.run(
    `UPDATE members SET first_name = ?, last_name = ?, preferred_name = ?, phone_encrypted = ?, phone_hash = ?, birth_month = ?, birth_day = ?, birth_year = ?, status = ?, ministry_group = ?, birthday_alert_allowed = ?, updated_at = ?, updated_by = ?, archived_at = ? WHERE id = ?`,
    data.firstName,
    data.lastName,
    data.preferredName,
    encryptValue(data.phone),
    phoneHash,
    data.birthMonth,
    data.birthDay,
    data.birthYear,
    data.status,
    data.ministryGroup,
    data.birthdayAlertAllowed,
    timestamp,
    user.id,
    data.status === 'archived' ? (existing.archived_at ?? timestamp) : null,
    id,
  );
  await audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'member_updated',
    entityType: 'member',
    entityId: id,
    summary: `Updated member record ${existing.member_code}.`,
  });

  const saved = await findMemberById(id);
  if (!saved) throw ApiError.notFound('Member could not be re-read after update.', 'MEMBER_NOT_FOUND');
  return toMemberDto(saved, user);
}

export async function archiveMember(id: string, user: SafeUser): Promise<void> {
  const existing = await findMemberById(id);
  if (!existing) throw ApiError.notFound('Member not found.', 'MEMBER_NOT_FOUND');
  const timestamp = nowIso();
  await db.run(
    `UPDATE members SET status = 'archived', archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
    timestamp,
    timestamp,
    user.id,
    existing.id,
  );
  await audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'member_archived',
    entityType: 'member',
    entityId: existing.id,
    summary: `Archived member record ${existing.member_code}.`,
  });
}

export interface MemberQuery {
  search?: string;
  status?: string;
  group?: string;
  page?: number;
  pageSize?: number;
}

export interface MemberListResult {
  items: MemberDto[];
  total: number;
  page: number;
  pageSize: number;
  groups: string[];
}

export async function listMembers(query: MemberQuery, user: SafeUser): Promise<MemberListResult> {
  const search = (query.search ?? '').trim();
  const status = (query.status ?? '').trim();
  const group = (query.group ?? '').trim();

  const where: string[] = [];
  const params: unknown[] = [];
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
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(query.pageSize) || 20));

  const total = await db.one<CountRow>(`SELECT COUNT(*)::int AS count FROM members ${clause}`, ...params);
  const rows = await db.all<MemberRow>(
    `SELECT * FROM members ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ...params,
    pageSize,
    (page - 1) * pageSize,
  );
  const groups = await db.all<{ name: string }>(
    'SELECT DISTINCT ministry_group AS name FROM members ORDER BY ministry_group',
  );

  return {
    items: rows.map((row) => toMemberDto(row, user)),
    total: Number(total?.count ?? 0),
    page,
    pageSize,
    groups: groups.map((item) => item.name),
  };
}

/**
 * Members whose birthday falls in the next `days` days, restricted to what the
 * requesting role is allowed to see. Phone numbers are never revealed here.
 */
export async function upcomingBirthdays(user: SafeUser, days = 14): Promise<UpcomingBirthdayDto[]> {
  const rule = await getNotificationRuleDto();
  const feb29Policy: Feb29Policy = rule?.feb29Policy ?? 'feb28';
  const rows = await db.all<MemberRow>(
    `SELECT * FROM members WHERE status = 'active' AND birthday_alert_allowed = TRUE AND consent_status != 'withdrawn'`,
  );

  const matching: UpcomingBirthdayDto[] = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const date = daysFromLagosToday(offset);
    for (const row of rows) {
      if (!birthdayMatchesDate(row, date, feb29Policy) || !canViewMember(user, row)) continue;
      matching.push({ ...memberDto(row, { revealPhone: false }), occurrenceDate: toIsoDate(date), daysUntil: offset });
    }
  }
  return matching.sort((a, b) => a.daysUntil - b.daysUntil || a.fullName.localeCompare(b.fullName));
}

export function memberPhonePreview(row: MemberRow): string | null {
  return decryptValue(row.phone_encrypted);
}
