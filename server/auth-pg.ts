import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { generateSecret, generateURI, verify } from 'otplib';
import { audit, db, decryptValue, encryptValue, lookupHash, newId, nowIso, safeUser } from './database-pg.js';

const ISSUER = process.env.TOTP_ISSUER || 'Living Water Mega Parish';
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MFA_PENDING_LIFETIME_MS = 15 * 60 * 1000;
const isProduction = process.env.NODE_ENV === 'production';

function isoAfter(milliseconds) { return new Date(Date.now() + milliseconds).toISOString(); }
function isExpired(isoDate) { return !isoDate || new Date(isoDate).getTime() < Date.now(); }
function normaliseToken(value) { return String(value || '').replace(/\s/g, '').toUpperCase(); }
function maskedEmail(email) { const [local, domain] = String(email || '').split('@'); if (!domain) return 'invited staff member'; const visible = local.slice(0, Math.min(2, local.length)); return `${visible}${'•'.repeat(Math.max(1, local.length - visible.length))}@${domain}`; }
function inviteHash(token) { return lookupHash(`staff-invite:${token}`); }
function providerRequestTimeout() { return Math.min(30000, Math.max(3000, Number(process.env.PROVIDER_REQUEST_TIMEOUT_MS || 10000))); }

export function mfaMethodsForUser(row) {
  return { totp: Boolean(row?.mfa_enrolled_at && row?.mfa_secret_encrypted), passkey: Boolean(row?.passkey_enrolled_at), required: Boolean(row?.mfa_required) };
}
export function hasEnrolledMfa(row) { const methods = mfaMethodsForUser(row); return methods.totp || methods.passkey; }

export async function beginTotpEnrollment(user) {
  const secret = generateSecret(); const pendingAt = nowIso();
  const uri = generateURI({ issuer: ISSUER, label: user.email, secret, digits: 6, period: 30 });
  const qrCodeDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 230, color: { dark: '#073c5a', light: '#ffffff' } });
  await db.run('UPDATE users SET mfa_pending_secret_encrypted = ?, mfa_pending_at = ?, updated_at = ? WHERE id = ?', encryptValue(secret), pendingAt, pendingAt, user.id);
  await audit({ actorId: user.id, actorName: user.full_name, action: 'totp_enrollment_started', entityType: 'authentication', entityId: user.id, summary: 'Started TOTP authenticator enrollment.' });
  return { qrCodeDataUrl, manualKey: secret, issuer: ISSUER, expiresAt: isoAfter(MFA_PENDING_LIFETIME_MS) };
}

function generateRecoveryCodes() {
  return Array.from({ length: 10 }, () => { const value = crypto.randomBytes(7).toString('base64url').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10); return `${value.slice(0, 5)}-${value.slice(5, 10)}`; });
}

export async function confirmTotpEnrollment(user, code) {
  const current = await db.one('SELECT * FROM users WHERE id = ?', user.id);
  const pendingExpiresAt = current?.mfa_pending_at ? new Date(new Date(current.mfa_pending_at).getTime() + MFA_PENDING_LIFETIME_MS).toISOString() : null;
  if (!current?.mfa_pending_secret_encrypted || isExpired(pendingExpiresAt)) throw new Error('This setup code has expired. Start MFA setup again.');
  const secret = decryptValue(current.mfa_pending_secret_encrypted);
  const verification = await verify({ secret, token: normaliseToken(code), epochTolerance: 30 });
  if (!verification.valid) throw new Error('That authenticator code is not valid. Check the time on your phone and try again.');
  const codes = generateRecoveryCodes(); const timestamp = nowIso();
  await db.transaction(async (tx) => {
    await tx.run(`UPDATE users SET mfa_secret_encrypted = ?, mfa_pending_secret_encrypted = NULL, mfa_pending_at = NULL, mfa_enrolled_at = ?, mfa_required = TRUE, mfa_state = 'totp_enrolled', updated_at = ? WHERE id = ?`, current.mfa_pending_secret_encrypted, timestamp, timestamp, current.id);
    await tx.run('DELETE FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL', current.id);
    for (const recoveryCode of codes) await tx.run('INSERT INTO mfa_recovery_codes (id, user_id, code_hash, created_at, used_at) VALUES (?, ?, ?, ?, NULL)', newId('recovery_'), current.id, lookupHash(`mfa-recovery:${recoveryCode}`), timestamp);
  });
  await audit({ actorId: current.id, actorName: current.full_name, action: 'totp_enrollment_completed', entityType: 'authentication', entityId: current.id, summary: 'Completed TOTP MFA enrollment and generated recovery codes.' });
  return { recoveryCodes: codes, user: safeUser(await db.one('SELECT * FROM users WHERE id = ?', current.id)) };
}

export async function verifyTotpCode(user, code) { const secret = decryptValue(user?.mfa_secret_encrypted); if (!secret) return false; return Boolean((await verify({ secret, token: normaliseToken(code), epochTolerance: 30 })).valid); }

export async function useRecoveryCode(userId, code) {
  const record = await db.one('SELECT * FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', userId, lookupHash(`mfa-recovery:${normaliseToken(code)}`));
  if (!record) return false;
  const outcome = await db.run('UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL', nowIso(), record.id);
  if (!outcome.changes) return false;
  await audit({ actorId: userId, actorName: 'Staff member', action: 'mfa_recovery_code_used', entityType: 'authentication', entityId: userId, summary: 'Used a one-time MFA recovery code.' });
  return true;
}

export async function getMfaStatus(userId) {
  const user = await db.one('SELECT * FROM users WHERE id = ?', userId); if (!user) return null;
  const unused = await db.one('SELECT COUNT(*)::int AS count FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL', userId);
  return { required: Boolean(user.mfa_required), totpEnrolled: Boolean(user.mfa_enrolled_at && user.mfa_secret_encrypted), passkeyEnrolled: Boolean(user.passkey_enrolled_at), enrolledAt: user.mfa_enrolled_at || null, recoveryCodesRemaining: Number(unused.count || 0) };
}

export async function regenerateRecoveryCodes(user, code) {
  if (!await verifyTotpCode(user, code)) throw new Error('Enter a current authenticator code to regenerate recovery codes.');
  const codes = generateRecoveryCodes(); const timestamp = nowIso();
  await db.transaction(async (tx) => { await tx.run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', user.id); for (const recoveryCode of codes) await tx.run('INSERT INTO mfa_recovery_codes (id, user_id, code_hash, created_at, used_at) VALUES (?, ?, ?, ?, NULL)', newId('recovery_'), user.id, lookupHash(`mfa-recovery:${recoveryCode}`), timestamp); });
  await audit({ actorId: user.id, actorName: user.full_name, action: 'mfa_recovery_codes_regenerated', entityType: 'authentication', entityId: user.id, summary: 'Regenerated one-time MFA recovery codes.' });
  return codes;
}

function invitationDto(row, { includeDebugLink = false, debugLink = null } = {}) {
  const expiration = new Date(row.expires_at).getTime(); const state = row.revoked_at ? 'revoked' : row.accepted_at ? 'accepted' : expiration < Date.now() ? 'expired' : 'pending';
  return { id: row.id, fullName: row.full_name, emailMasked: maskedEmail(row.email), role: row.role, groupScope: JSON.parse(row.group_scope || '[]'), state, expiresAt: row.expires_at, acceptedAt: row.accepted_at, createdAt: row.created_at, lastSentAt: row.last_sent_at, deliveryProvider: row.delivery_provider, deliveryStatus: row.delivery_status, debugInviteLink: includeDebugLink ? debugLink : undefined };
}

async function sendInviteEmail({ fullName, email, link, role }) {
  const mode = process.env.EMAIL_MODE || 'mock';
  if (mode === 'mock') { if (isProduction) throw new Error('EMAIL_MODE=mock is not permitted in production. Configure Resend and a verified parish sender address.'); return { provider: 'mock', status: 'delivered' }; }
  if (mode !== 'resend') throw new Error(`Unsupported EMAIL_MODE: ${mode}`);
  const apiKey = process.env.RESEND_API_KEY; const from = process.env.INVITE_FROM_EMAIL;
  if (!apiKey || !from) throw new Error('Resend invitation email is not configured. Set RESEND_API_KEY and INVITE_FROM_EMAIL in Render.');
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(providerRequestTimeout()), body: JSON.stringify({ from, to: [email], subject: 'Your Living Water Birthday Care staff invitation', text: `Hello ${fullName},\n\nYou have been invited as ${role.replace(/_/g, ' ')} to the Living Water Mega Parish Birthday Care workspace.\n\nCreate your account and enrol MFA here: ${link}\n\nThis invitation expires in 7 days. If you were not expecting it, contact the parish administrator.` }) });
  const payload: any = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload?.message || 'The invitation email provider rejected the request.');
  return { provider: 'resend', status: 'delivered', providerMessageId: payload.id || null };
}

export async function createStaffInvitation({ fullName, email, role, groupScope = [] }, actor, appBaseUrl) {
  const normalizedEmail = String(email).trim().toLowerCase();
  if (await db.one('SELECT id FROM users WHERE email = ?', normalizedEmail)) throw new Error('This email already belongs to a staff account. Manage that account instead of creating an invitation.');
  const existing = await db.one(`SELECT * FROM staff_invitations WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, normalizedEmail);
  if (existing && !isExpired(existing.expires_at)) throw new Error('A valid invitation for this email already exists. Revoke it before creating another.');
  const token = crypto.randomBytes(32).toString('base64url'); const timestamp = nowIso(); const id = newId('invite_'); const link = `${String(appBaseUrl).replace(/\/$/, '')}/invite/${token}`;
  await db.run(`INSERT INTO staff_invitations (id, full_name, email, role, group_scope, token_hash, expires_at, created_by, created_at, last_sent_at, delivery_provider, delivery_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')`, id, fullName, normalizedEmail, role, JSON.stringify(groupScope), inviteHash(token), isoAfter(INVITE_LIFETIME_MS), actor.id, timestamp, timestamp);
  let delivery;
  try { delivery = await sendInviteEmail({ fullName, email: normalizedEmail, link, role }); await db.run('UPDATE staff_invitations SET delivery_provider = ?, delivery_status = ?, last_sent_at = ? WHERE id = ?', delivery.provider, delivery.status, nowIso(), id); }
  catch (error) { await db.run(`UPDATE staff_invitations SET delivery_provider = ?, delivery_status = 'failed', delivery_error = ? WHERE id = ?`, process.env.EMAIL_MODE || 'mock', String(error.message || error).slice(0, 500), id); delivery = { provider: process.env.EMAIL_MODE || 'mock', status: 'failed', error: String(error.message || error) }; }
  const invitation = await db.one('SELECT * FROM staff_invitations WHERE id = ?', id);
  await audit({ actorId: actor.id, actorName: actor.fullName, action: 'staff_invitation_created', entityType: 'staff_invitation', entityId: id, summary: `Invited a ${role.replace(/_/g, ' ')} to the staff workspace.`, metadata: { role, emailMasked: maskedEmail(normalizedEmail), deliveryStatus: delivery.status } });
  return { invitation: invitationDto(invitation, { includeDebugLink: !isProduction && (process.env.EMAIL_MODE || 'mock') === 'mock', debugLink: link }), delivery };
}

export async function listStaffAccess() {
  const users = (await db.all('SELECT * FROM users ORDER BY active DESC, full_name ASC')).map((row) => ({ ...safeUser(row), roleLabel: row.role.replace(/_/g, ' '), mfa: mfaMethodsForUser(row), createdAt: row.created_at }));
  const invitations = (await db.all('SELECT * FROM staff_invitations ORDER BY created_at DESC LIMIT 30')).map((row) => invitationDto(row));
  return { users, invitations };
}
export async function findInvitation(token) { const row = await db.one('SELECT * FROM staff_invitations WHERE token_hash = ?', inviteHash(token)); return !row || row.revoked_at || row.accepted_at || isExpired(row.expires_at) ? null : row; }
export function publicInvitationDto(row) { return { parishName: 'Living Water Mega Parish – RCCG', fullName: row.full_name, emailMasked: maskedEmail(row.email), role: row.role, groupScope: JSON.parse(row.group_scope || '[]'), expiresAt: row.expires_at }; }

export async function acceptStaffInvitation(token, password) {
  const invitation = await findInvitation(token); if (!invitation) throw new Error('This invitation is invalid, expired, revoked, or already used. Ask a parish owner to send a new invitation.');
  const timestamp = nowIso(); const passwordHash = await bcrypt.hash(password, 12); const userId = newId('usr_');
  await db.transaction(async (tx) => { await tx.run(`INSERT INTO users (id, full_name, email, password_hash, role, group_scope, mfa_state, mfa_required, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'enrollment_required', TRUE, TRUE, ?, ?)`, userId, invitation.full_name, invitation.email, passwordHash, invitation.role, invitation.group_scope, timestamp, timestamp); await tx.run('UPDATE staff_invitations SET accepted_at = ? WHERE id = ?', timestamp, invitation.id); });
  const user = await db.one('SELECT * FROM users WHERE id = ?', userId);
  await audit({ actorId: userId, actorName: invitation.full_name, action: 'staff_invitation_accepted', entityType: 'staff_invitation', entityId: invitation.id, summary: 'Accepted a staff invitation and started required MFA enrollment.' });
  return safeUser(user);
}

export async function revokeInvitation(id, actor) { const invitation = await db.one('SELECT * FROM staff_invitations WHERE id = ?', id); if (!invitation) throw new Error('Invitation not found.'); if (invitation.accepted_at) throw new Error('An accepted invitation cannot be revoked. Deactivate the staff account instead.'); await db.run('UPDATE staff_invitations SET revoked_at = ? WHERE id = ?', nowIso(), id); await audit({ actorId: actor.id, actorName: actor.fullName, action: 'staff_invitation_revoked', entityType: 'staff_invitation', entityId: id, summary: 'Revoked a pending staff invitation.' }); }

export async function deactivateStaffAccount(id, actor) { if (id === actor.id) throw new Error('You cannot deactivate your own account. Ask another Organisation Owner to do this.'); const target = await db.one('SELECT * FROM users WHERE id = ?', id); if (!target) throw new Error('Staff account not found.'); if (target.role === 'owner') { const result = await db.one(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'owner' AND active = TRUE`); if (Number(result.count) <= 1) throw new Error('Keep at least one active Organisation Owner account. Invite another owner before deactivating this one.'); } await db.run('UPDATE users SET active = FALSE, updated_at = ? WHERE id = ?', nowIso(), id); await audit({ actorId: actor.id, actorName: actor.fullName, action: 'staff_account_deactivated', entityType: 'user', entityId: id, summary: `Deactivated a ${target.role.replace(/_/g, ' ')} staff account.` }); }
