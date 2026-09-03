// One-time production initialization after migrations. Secrets stay in the shell/Render environment.
import bcrypt from 'bcryptjs';
import { audit, db, newId, nowIso, pool } from '../server/database-pg.js';

const name = String(process.env.BOOTSTRAP_OWNER_NAME || '').trim();
const email = String(process.env.BOOTSTRAP_OWNER_EMAIL || '').trim().toLowerCase();
const password = String(process.env.BOOTSTRAP_OWNER_PASSWORD || '');
if (name.length < 3 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
  console.error('Set BOOTSTRAP_OWNER_NAME, BOOTSTRAP_OWNER_EMAIL, and a 12+ character BOOTSTRAP_OWNER_PASSWORD with upper/lower-case letters and a number.');
  process.exit(1);
}

try {
  const owner = await db.one(`SELECT id FROM users WHERE role = 'owner' AND active = TRUE LIMIT 1`);
  if (owner) throw new Error('An active Organisation Owner already exists. Refusing to create another bootstrap owner. Use the staff invitation flow instead.');
  const timestamp = nowIso();
  const id = newId('usr_');
  const passwordHash = await bcrypt.hash(password, 12);
  await db.transaction(async (tx) => {
    await tx.run(`INSERT INTO users (id, full_name, email, password_hash, role, group_scope, mfa_state, mfa_required, active, created_at, updated_at) VALUES (?, ?, ?, ?, 'owner', '[]', 'enrollment_required', TRUE, TRUE, ?, ?)`, id, name, email, passwordHash, timestamp, timestamp);
    await tx.run(`INSERT INTO notification_rules (id, name, enabled, digest_mode, alert_time, timezone, days_before, primary_channel, sms_fallback, feb29_policy, updated_at, updated_by) VALUES ('rule_daily_birthday', 'Daily birthday care digest', TRUE, 'daily_digest', '07:30', 'Africa/Lagos', 0, 'whatsapp', TRUE, 'feb28', ?, ?) ON CONFLICT(id) DO NOTHING`, timestamp, id);
    await tx.run(`INSERT INTO app_settings (setting_key, setting_value, updated_at, updated_by) VALUES ('parish_profile', ?, ?, ?) ON CONFLICT(setting_key) DO NOTHING`, JSON.stringify({ parishName: 'Living Water Mega Parish – RCCG', timezone: 'Africa/Lagos', environment: 'production' }), timestamp, id);
  });
  await audit({ actorId: id, actorName: name, action: 'bootstrap_owner_created', entityType: 'user', entityId: id, summary: 'Created the initial Organisation Owner; MFA enrollment is required at first sign-in.' });
  console.log(`Initial Organisation Owner created for ${email}. Sign in through the HTTPS app and enrol MFA immediately.`);
} catch (error) {
  console.error(`Bootstrap failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
