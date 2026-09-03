import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { generateSecret, generateURI, verify } from 'otplib';
import { config, providerRequestTimeoutMs } from './config.js';
import { ApiError } from './errors.js';
import { logger } from './logger.js';
import { audit, db, decryptValue, encryptValue, lookupHash, newId, nowIso, safeUser } from './database-pg.js';
import { maskedEmail } from './domain/masking.js';
import type {
  CountRow,
  InvitationDto,
  InvitationState,
  MfaMethods,
  MfaStatusDto,
  PublicInvitationDto,
  RecoveryCodeRow,
  SafeUser,
  StaffAccessDto,
  StaffInvitationRow,
  StaffListItem,
  TotpEnrollmentDto,
  UserRow,
  UserRole,
} from './types.js';

const ISSUER = config.TOTP_ISSUER;
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MFA_PENDING_LIFETIME_MS = 15 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const PARISH_NAME = 'Living Water Mega Parish – RCCG';

interface EmailDelivery {
  provider: string;
  status: 'delivered' | 'failed';
  providerMessageId?: string | null;
  error?: string;
}

function isoAfter(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

function isExpired(isoDate: string | null | undefined): boolean {
  if (!isoDate) return true;
  return new Date(isoDate).getTime() < Date.now();
}

function normaliseToken(value: string): string {
  return String(value ?? '')
    .replace(/\s/g, '')
    .toUpperCase();
}

function inviteHash(token: string): string {
  return lookupHash(`staff-invite:${token}`);
}

/* ------------------------------------------------------------------ *
 * MFA
 * ------------------------------------------------------------------ */

export function mfaMethodsForUser(row: UserRow | null): MfaMethods {
  return {
    totp: Boolean(row?.mfa_enrolled_at && row?.mfa_secret_encrypted),
    passkey: Boolean(row?.passkey_enrolled_at),
    required: Boolean(row?.mfa_required),
  };
}

export function hasEnrolledMfa(row: UserRow | null): boolean {
  const methods = mfaMethodsForUser(row);
  return methods.totp || methods.passkey;
}

export async function beginTotpEnrollment(user: UserRow): Promise<TotpEnrollmentDto> {
  const secret = generateSecret();
  const pendingAt = nowIso();
  const uri = generateURI({ issuer: ISSUER, label: user.email, secret, digits: 6, period: 30 });
  const qrCodeDataUrl = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 230,
    color: { dark: '#073c5a', light: '#ffffff' },
  });
  await db.run(
    'UPDATE users SET mfa_pending_secret_encrypted = ?, mfa_pending_at = ?, updated_at = ? WHERE id = ?',
    encryptValue(secret),
    pendingAt,
    pendingAt,
    user.id,
  );
  await audit({
    actorId: user.id,
    actorName: user.full_name,
    action: 'totp_enrollment_started',
    entityType: 'authentication',
    entityId: user.id,
    summary: 'Started TOTP authenticator enrollment.',
  });
  return { qrCodeDataUrl, manualKey: secret, issuer: ISSUER, expiresAt: isoAfter(MFA_PENDING_LIFETIME_MS) };
}

function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const value = crypto
      .randomBytes(7)
      .toString('base64url')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 10);
    return `${value.slice(0, 5)}-${value.slice(5, 10)}`;
  });
}

export async function confirmTotpEnrollment(
  user: UserRow,
  code: string,
): Promise<{ recoveryCodes: string[]; user: SafeUser | null }> {
  const current = await db.one<UserRow>('SELECT * FROM users WHERE id = ?', user.id);
  const pendingExpiresAt = current?.mfa_pending_at
    ? new Date(new Date(current.mfa_pending_at).getTime() + MFA_PENDING_LIFETIME_MS).toISOString()
    : null;
  if (!current?.mfa_pending_secret_encrypted || isExpired(pendingExpiresAt)) {
    throw ApiError.unprocessable('This setup code has expired. Start MFA setup again.', 'MFA_SETUP_EXPIRED');
  }
  const secret = decryptValue(current.mfa_pending_secret_encrypted);
  if (!secret) throw ApiError.unprocessable('MFA setup is unavailable. Start again.', 'MFA_SETUP_EXPIRED');

  const verification = await verify({ secret, token: normaliseToken(code), epochTolerance: 30 });
  if (!verification.valid) {
    throw ApiError.unprocessable(
      'That authenticator code is not valid. Check the time on your phone and try again.',
      'INVALID_TOTP_CODE',
    );
  }

  const codes = generateRecoveryCodes();
  const timestamp = nowIso();
  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE users SET mfa_secret_encrypted = ?, mfa_pending_secret_encrypted = NULL, mfa_pending_at = NULL, mfa_enrolled_at = ?, mfa_required = TRUE, mfa_state = 'totp_enrolled', updated_at = ? WHERE id = ?`,
      current.mfa_pending_secret_encrypted,
      timestamp,
      timestamp,
      current.id,
    );
    await tx.run('DELETE FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL', current.id);
    for (const recoveryCode of codes) {
      await tx.run(
        'INSERT INTO mfa_recovery_codes (id, user_id, code_hash, created_at, used_at) VALUES (?, ?, ?, ?, NULL)',
        newId('recovery_'),
        current.id,
        lookupHash(`mfa-recovery:${recoveryCode}`),
        timestamp,
      );
    }
  });
  await audit({
    actorId: current.id,
    actorName: current.full_name,
    action: 'totp_enrollment_completed',
    entityType: 'authentication',
    entityId: current.id,
    summary: 'Completed TOTP MFA enrollment and generated recovery codes.',
  });
  return {
    recoveryCodes: codes,
    user: safeUser(await db.one<UserRow>('SELECT * FROM users WHERE id = ?', current.id)),
  };
}

export async function verifyTotpCode(user: UserRow | null, code: string): Promise<boolean> {
  const secret = decryptValue(user?.mfa_secret_encrypted);
  if (!secret) return false;
  const result = await verify({ secret, token: normaliseToken(code), epochTolerance: 30 });
  return Boolean(result.valid);
}

export async function useRecoveryCode(userId: string, code: string): Promise<boolean> {
  const record = await db.one<RecoveryCodeRow>(
    'SELECT * FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    userId,
    lookupHash(`mfa-recovery:${normaliseToken(code)}`),
  );
  if (!record) return false;
  const outcome = await db.run(
    'UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL',
    nowIso(),
    record.id,
  );
  if (!outcome.changes) return false;
  await audit({
    actorId: userId,
    actorName: 'Staff member',
    action: 'mfa_recovery_code_used',
    entityType: 'authentication',
    entityId: userId,
    summary: 'Used a one-time MFA recovery code.',
  });
  return true;
}

export async function getMfaStatus(userId: string): Promise<MfaStatusDto | null> {
  const user = await db.one<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  if (!user) return null;
  const unused = await db.one<CountRow>(
    'SELECT COUNT(*)::int AS count FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL',
    userId,
  );
  return {
    required: Boolean(user.mfa_required),
    totpEnrolled: Boolean(user.mfa_enrolled_at && user.mfa_secret_encrypted),
    passkeyEnrolled: Boolean(user.passkey_enrolled_at),
    enrolledAt: user.mfa_enrolled_at ?? null,
    recoveryCodesRemaining: Number(unused?.count ?? 0),
  };
}

export async function regenerateRecoveryCodes(user: UserRow, code: string): Promise<string[]> {
  if (!(await verifyTotpCode(user, code))) {
    throw ApiError.unprocessable(
      'Enter a current authenticator code to regenerate recovery codes.',
      'INVALID_TOTP_CODE',
    );
  }
  const codes = generateRecoveryCodes();
  const timestamp = nowIso();
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', user.id);
    for (const recoveryCode of codes) {
      await tx.run(
        'INSERT INTO mfa_recovery_codes (id, user_id, code_hash, created_at, used_at) VALUES (?, ?, ?, ?, NULL)',
        newId('recovery_'),
        user.id,
        lookupHash(`mfa-recovery:${recoveryCode}`),
        timestamp,
      );
    }
  });
  await audit({
    actorId: user.id,
    actorName: user.full_name,
    action: 'mfa_recovery_codes_regenerated',
    entityType: 'authentication',
    entityId: user.id,
    summary: 'Regenerated one-time MFA recovery codes.',
  });
  return codes;
}

/* ------------------------------------------------------------------ *
 * Staff invitations
 * ------------------------------------------------------------------ */

interface InvitationDtoOptions {
  includeDebugLink?: boolean;
  debugLink?: string | null;
}

function invitationState(row: StaffInvitationRow): InvitationState {
  if (row.revoked_at) return 'revoked';
  if (row.accepted_at) return 'accepted';
  return isExpired(row.expires_at) ? 'expired' : 'pending';
}

function invitationDto(
  row: StaffInvitationRow,
  { includeDebugLink = false, debugLink = null }: InvitationDtoOptions = {},
): InvitationDto {
  return {
    id: row.id,
    fullName: row.full_name,
    emailMasked: maskedEmail(row.email),
    role: row.role,
    groupScope: JSON.parse(row.group_scope || '[]') as string[],
    state: invitationState(row),
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    lastSentAt: row.last_sent_at,
    deliveryProvider: row.delivery_provider,
    deliveryStatus: row.delivery_status,
    ...(includeDebugLink && debugLink ? { debugInviteLink: debugLink } : {}),
  };
}

async function sendInviteEmail({
  fullName,
  email,
  link,
  role,
}: {
  fullName: string;
  email: string;
  link: string;
  role: UserRole;
}): Promise<EmailDelivery> {
  const mode = config.EMAIL_MODE;
  if (mode === 'mock') {
    if (config.isProduction) {
      throw new Error(
        'EMAIL_MODE=mock is not permitted in production. Configure Resend and a verified parish sender address.',
      );
    }
    return { provider: 'mock', status: 'delivered' };
  }

  const apiKey = config.RESEND_API_KEY;
  const from = config.INVITE_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error('Resend invitation email is not configured. Set RESEND_API_KEY and INVITE_FROM_EMAIL.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(providerRequestTimeoutMs()),
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Your Living Water Birthday Care staff invitation',
      text: [
        `Hello ${fullName},`,
        '',
        `You have been invited as ${role.replace(/_/g, ' ')} to the Living Water Mega Parish Birthday Care workspace.`,
        '',
        `Create your account and enrol MFA here: ${link}`,
        '',
        'This invitation expires in 7 days. If you were not expecting it, contact the parish administrator.',
      ].join('\n'),
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) throw new Error(payload?.message || 'The invitation email provider rejected the request.');
  return { provider: 'resend', status: 'delivered', providerMessageId: payload.id ?? null };
}

export interface StaffInvitationInput {
  fullName: string;
  email: string;
  role: UserRole;
  groupScope?: string[];
}

export async function createStaffInvitation(
  { fullName, email, role, groupScope = [] }: StaffInvitationInput,
  actor: SafeUser,
  appBaseUrl: string,
): Promise<{ invitation: InvitationDto; delivery: EmailDelivery }> {
  const normalizedEmail = String(email).trim().toLowerCase();
  if (await db.one<Pick<UserRow, 'id'>>('SELECT id FROM users WHERE email = ?', normalizedEmail)) {
    throw ApiError.conflict(
      'This email already belongs to a staff account. Manage that account instead of creating an invitation.',
      'INVITATION_EMAIL_TAKEN',
    );
  }
  const existing = await db.one<StaffInvitationRow>(
    `SELECT * FROM staff_invitations WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    normalizedEmail,
  );
  if (existing && !isExpired(existing.expires_at)) {
    throw ApiError.conflict(
      'A valid invitation for this email already exists. Revoke it before creating another.',
      'INVITATION_ALREADY_EXISTS',
    );
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const timestamp = nowIso();
  const id = newId('invite_');
  const link = `${String(appBaseUrl).replace(/\/$/, '')}/invite/${token}`;

  await db.run(
    `INSERT INTO staff_invitations (id, full_name, email, role, group_scope, token_hash, expires_at, created_by, created_at, last_sent_at, delivery_provider, delivery_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')`,
    id,
    fullName,
    normalizedEmail,
    role,
    JSON.stringify(groupScope),
    inviteHash(token),
    isoAfter(INVITE_LIFETIME_MS),
    actor.id,
    timestamp,
    timestamp,
  );

  let delivery: EmailDelivery;
  try {
    delivery = await sendInviteEmail({ fullName, email: normalizedEmail, link, role });
    await db.run(
      'UPDATE staff_invitations SET delivery_provider = ?, delivery_status = ?, last_sent_at = ? WHERE id = ?',
      delivery.provider,
      delivery.status,
      nowIso(),
      id,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.run(
      `UPDATE staff_invitations SET delivery_provider = ?, delivery_status = 'failed', delivery_error = ? WHERE id = ?`,
      config.EMAIL_MODE,
      message.slice(0, 500),
      id,
    );
    logger.warn('Staff invitation email delivery failed', { provider: config.EMAIL_MODE });
    delivery = { provider: config.EMAIL_MODE, status: 'failed', error: message };
  }

  const invitation = await db.one<StaffInvitationRow>('SELECT * FROM staff_invitations WHERE id = ?', id);
  if (!invitation) throw ApiError.notFound('Invitation could not be re-read after creation.', 'INVITATION_NOT_FOUND');

  await audit({
    actorId: actor.id,
    actorName: actor.fullName,
    action: 'staff_invitation_created',
    entityType: 'staff_invitation',
    entityId: id,
    summary: `Invited a ${role.replace(/_/g, ' ')} to the staff workspace.`,
    metadata: { role, emailMasked: maskedEmail(normalizedEmail), deliveryStatus: delivery.status },
  });

  return {
    invitation: invitationDto(invitation, {
      includeDebugLink: config.EMAIL_MODE === 'mock' && !config.isProduction,
      debugLink: link,
    }),
    delivery,
  };
}

export async function listStaffAccess(): Promise<StaffAccessDto> {
  const userRows = await db.all<UserRow>('SELECT * FROM users ORDER BY active DESC, full_name ASC');
  const users: StaffListItem[] = userRows.flatMap((row) => {
    const safe = safeUser(row);
    if (!safe) return [];
    return [
      { ...safe, roleLabel: row.role.replace(/_/g, ' '), mfa: mfaMethodsForUser(row), createdAt: row.created_at },
    ];
  });
  const invitations = (
    await db.all<StaffInvitationRow>('SELECT * FROM staff_invitations ORDER BY created_at DESC LIMIT 30')
  ).map((row) => invitationDto(row));
  return { users, invitations };
}

export async function findInvitation(token: string): Promise<StaffInvitationRow | null> {
  const row = await db.one<StaffInvitationRow>(
    'SELECT * FROM staff_invitations WHERE token_hash = ?',
    inviteHash(token),
  );
  if (!row || row.revoked_at || row.accepted_at || isExpired(row.expires_at)) return null;
  return row;
}

export function publicInvitationDto(row: StaffInvitationRow): PublicInvitationDto {
  return {
    parishName: PARISH_NAME,
    fullName: row.full_name,
    emailMasked: maskedEmail(row.email),
    role: row.role,
    groupScope: JSON.parse(row.group_scope || '[]') as string[],
    expiresAt: row.expires_at,
  };
}

export async function acceptStaffInvitation(token: string, password: string): Promise<SafeUser | null> {
  const invitation = await findInvitation(token);
  if (!invitation) {
    throw ApiError.notFound(
      'This invitation is invalid, expired, revoked, or already used. Ask a parish owner to send a new invitation.',
      'INVITATION_NOT_FOUND',
    );
  }
  const timestamp = nowIso();
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = newId('usr_');
  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO users (id, full_name, email, password_hash, role, group_scope, mfa_state, mfa_required, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'enrollment_required', TRUE, TRUE, ?, ?)`,
      userId,
      invitation.full_name,
      invitation.email,
      passwordHash,
      invitation.role,
      invitation.group_scope,
      timestamp,
      timestamp,
    );
    await tx.run('UPDATE staff_invitations SET accepted_at = ? WHERE id = ?', timestamp, invitation.id);
  });
  const user = await db.one<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  await audit({
    actorId: userId,
    actorName: invitation.full_name,
    action: 'staff_invitation_accepted',
    entityType: 'staff_invitation',
    entityId: invitation.id,
    summary: 'Accepted a staff invitation and started required MFA enrollment.',
  });
  return safeUser(user);
}

export async function revokeInvitation(id: string, actor: SafeUser): Promise<void> {
  const invitation = await db.one<StaffInvitationRow>('SELECT * FROM staff_invitations WHERE id = ?', id);
  if (!invitation) throw ApiError.notFound('Invitation not found.', 'INVITATION_NOT_FOUND');
  if (invitation.accepted_at) {
    throw ApiError.conflict(
      'An accepted invitation cannot be revoked. Deactivate the staff account instead.',
      'INVITATION_ALREADY_ACCEPTED',
    );
  }
  await db.run('UPDATE staff_invitations SET revoked_at = ? WHERE id = ?', nowIso(), id);
  await audit({
    actorId: actor.id,
    actorName: actor.fullName,
    action: 'staff_invitation_revoked',
    entityType: 'staff_invitation',
    entityId: id,
    summary: 'Revoked a pending staff invitation.',
  });
}

export async function deactivateStaffAccount(id: string, actor: SafeUser): Promise<void> {
  if (id === actor.id) {
    throw ApiError.conflict(
      'You cannot deactivate your own account. Ask another Organisation Owner to do this.',
      'SELF_DEACTIVATION_FORBIDDEN',
    );
  }
  const target = await db.one<UserRow>('SELECT * FROM users WHERE id = ?', id);
  if (!target) throw ApiError.notFound('Staff account not found.', 'STAFF_NOT_FOUND');
  if (target.role === 'owner') {
    const result = await db.one<CountRow>(
      `SELECT COUNT(*)::int AS count FROM users WHERE role = 'owner' AND active = TRUE`,
    );
    if (Number(result?.count ?? 0) <= 1) {
      throw ApiError.conflict(
        'Keep at least one active Organisation Owner account. Invite another owner before deactivating this one.',
        'LAST_OWNER_PROTECTED',
      );
    }
  }
  await db.run('UPDATE users SET active = FALSE, updated_at = ? WHERE id = ?', nowIso(), id);
  await audit({
    actorId: actor.id,
    actorName: actor.fullName,
    action: 'staff_account_deactivated',
    entityType: 'user',
    entityId: id,
    summary: `Deactivated a ${target.role.replace(/_/g, ' ')} staff account.`,
  });
}
