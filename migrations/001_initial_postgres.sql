-- Living Water Birthday Care: production PostgreSQL schema.
-- All times are stored as ISO-8601 UTC text so the existing application DTOs remain stable.
-- The application encrypts phone values before they enter this database.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','membership_officer','birthday_coordinator','auditor')),
  group_scope TEXT NOT NULL DEFAULT '[]',
  mfa_state TEXT NOT NULL DEFAULT 'required',
  mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret_encrypted TEXT,
  mfa_pending_secret_encrypted TEXT,
  mfa_pending_at TEXT,
  mfa_enrolled_at TEXT,
  passkey_enrolled_at TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_invitations (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','membership_officer','birthday_coordinator','auditor')),
  group_scope TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_sent_at TEXT,
  delivery_provider TEXT,
  delivery_status TEXT,
  delivery_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitation_email ON staff_invitations (email, created_at DESC);

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON mfa_recovery_codes (user_id, used_at);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT,
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys (user_id);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  member_code TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  phone_encrypted TEXT,
  phone_hash TEXT,
  birth_month INTEGER NOT NULL CHECK (birth_month BETWEEN 1 AND 12),
  birth_day INTEGER NOT NULL CHECK (birth_day BETWEEN 1 AND 31),
  birth_year INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','visitor','inactive','archived','deceased')),
  ministry_group TEXT NOT NULL DEFAULT 'General',
  birthday_alert_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  consent_status TEXT NOT NULL DEFAULT 'recorded' CHECK (consent_status IN ('recorded','review_required','withdrawn')),
  consent_at TEXT,
  privacy_notice_version TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_birthday ON members (status, birthday_alert_allowed, birth_month, birth_day);
CREATE INDEX IF NOT EXISTS idx_members_phone_hash ON members (phone_hash);
CREATE INDEX IF NOT EXISTS idx_members_name ON members (last_name, first_name);

CREATE TABLE IF NOT EXISTS consent_records (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  lawful_basis TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('recorded','withdrawn','updated')),
  source TEXT NOT NULL,
  notice_version TEXT,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_consent_member ON consent_records (member_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS admin_endpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','sms')),
  phone_encrypted TEXT NOT NULL,
  phone_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  verified_at TEXT,
  opted_in_at TEXT,
  opted_out_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_endpoints_user ON admin_endpoints (user_id, enabled, priority);

CREATE TABLE IF NOT EXISTS endpoint_verifications (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES admin_endpoints(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'endpoint_ownership',
  delivery_channel TEXT NOT NULL DEFAULT 'sms',
  provider TEXT,
  provider_message_id TEXT,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_endpoint_verification_endpoint ON endpoint_verifications (endpoint_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS notification_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  digest_mode TEXT NOT NULL DEFAULT 'daily_digest' CHECK (digest_mode IN ('daily_digest','individual')),
  alert_time TEXT NOT NULL DEFAULT '07:30',
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  days_before INTEGER NOT NULL DEFAULT 0 CHECK (days_before BETWEEN 0 AND 14),
  primary_channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (primary_channel IN ('whatsapp','sms')),
  sms_fallback BOOLEAN NOT NULL DEFAULT TRUE,
  feb29_policy TEXT NOT NULL DEFAULT 'feb28' CHECK (feb29_policy IN ('feb28','mar1')),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  notification_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES admin_endpoints(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','sms')),
  notification_type TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  message_preview TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('scheduled','queued','provider_accepted','sent','delivered','read','failed','retrying','dead_letter')),
  provider TEXT,
  provider_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT,
  read_at TEXT,
  last_event_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_provider_message ON notifications (provider_message_id);

CREATE TABLE IF NOT EXISTS provider_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE,
  notification_id TEXT REFERENCES notifications(id) ON DELETE SET NULL,
  event_type TEXT,
  payload_summary TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox_jobs (status, due_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events (created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
