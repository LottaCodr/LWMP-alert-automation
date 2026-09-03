import crypto from 'node:crypto';
import { z } from 'zod';
import { config, exposesDemoHints } from '../config.js';
import { ApiError, errorMessage } from '../errors.js';
import { audit, db, decryptValue, encryptValue, endpointDto, lookupHash, newId, nowIso } from '../database-pg.js';
import { sendEndpointVerificationSms, verifyTermiiOtp } from '../notification-pg.js';
import type {
  AdminEndpointRow,
  EndpointDto,
  EndpointVerificationDto,
  EndpointVerificationRow,
  SafeUser,
} from '../types.js';

const VERIFICATION_LIFETIME_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

export const endpointCreateSchema = z.object({
  channel: z.enum(['whatsapp', 'sms']),
  phone: z.string().min(7).max(40),
  label: z.string().trim().min(2).max(80),
  priority: z.coerce.number().int().min(1).max(10).default(1),
  optInConfirmed: z.literal(true),
});

export const endpointUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.coerce.number().int().min(1).max(10).optional(),
});

export function endpointCanBeManagedBy(endpoint: AdminEndpointRow, user: SafeUser): boolean {
  return endpoint.user_id === user.id || user.role === 'owner';
}

export async function findEndpoint(id: string): Promise<AdminEndpointRow | null> {
  return db.one<AdminEndpointRow>('SELECT * FROM admin_endpoints WHERE id = ?', id);
}

async function assertManageableEndpoint(id: string, user: SafeUser): Promise<AdminEndpointRow> {
  const endpoint = await findEndpoint(id);
  if (!endpoint) throw ApiError.notFound('Notification endpoint not found.', 'ENDPOINT_NOT_FOUND');
  if (!endpointCanBeManagedBy(endpoint, user)) {
    throw ApiError.forbidden('You can only manage your own notification endpoints.');
  }
  return endpoint;
}

export async function requestEndpointVerification(
  endpoint: AdminEndpointRow,
  actor: SafeUser,
): Promise<EndpointVerificationDto> {
  const phone = decryptValue(endpoint.phone_encrypted);
  if (!phone) throw ApiError.unprocessable('This endpoint has no usable phone number.', 'ENDPOINT_PHONE_UNAVAILABLE');

  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + VERIFICATION_LIFETIME_MS).toISOString();
  const code = String(crypto.randomInt(100_000, 1_000_000));
  const id = newId('endpoint_verify_');

  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM endpoint_verifications WHERE endpoint_id = ? AND consumed_at IS NULL', endpoint.id);
    await tx.run(
      `INSERT INTO endpoint_verifications (id, endpoint_id, code_hash, purpose, delivery_channel, provider, provider_message_id, requested_at, expires_at, attempts)
       VALUES (?, ?, ?, 'endpoint_ownership', 'sms', NULL, NULL, ?, ?, 0)`,
      id,
      endpoint.id,
      lookupHash(`endpoint-verification:${endpoint.id}:${code}`),
      timestamp,
      expiresAt,
    );
  });

  try {
    const delivery = await sendEndpointVerificationSms(phone, code);
    await db.run(
      'UPDATE endpoint_verifications SET provider = ?, provider_message_id = ? WHERE id = ?',
      delivery.provider ?? null,
      delivery.providerMessageId ?? null,
      id,
    );
    await audit({
      actorId: actor.id,
      actorName: actor.fullName,
      action: 'endpoint_verification_requested',
      entityType: 'admin_endpoint',
      entityId: endpoint.id,
      summary: `Sent an SMS ownership verification challenge for a ${endpoint.channel} endpoint.`,
      metadata: { provider: delivery.provider, channel: endpoint.channel },
    });
    return {
      expiresAt,
      deliveryMode: config.MESSAGE_MODE,
      ...(exposesDemoHints ? { debugCode: code } : {}),
    };
  } catch (error) {
    await db.run('DELETE FROM endpoint_verifications WHERE id = ?', id);
    throw ApiError.unavailable(
      `Could not send the verification SMS. ${errorMessage(error)}`.trim(),
      'ENDPOINT_VERIFICATION_SEND_FAILED',
    );
  }
}

export interface CreateEndpointInput {
  channel: 'whatsapp' | 'sms';
  phone: string;
  label: string;
  priority: number;
}

export async function createEndpoint(
  data: CreateEndpointInput,
  phone: string,
  user: SafeUser,
): Promise<{ endpoint: EndpointDto; verification: EndpointVerificationDto }> {
  const timestamp = nowIso();
  const id = newId('endpoint_');
  await db.run(
    `INSERT INTO admin_endpoints (id, user_id, channel, phone_encrypted, phone_hash, label, priority, enabled, verified_at, opted_in_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, NULL, ?, ?, ?)`,
    id,
    user.id,
    data.channel,
    encryptValue(phone),
    lookupHash(phone),
    data.label,
    data.priority,
    timestamp,
    timestamp,
    timestamp,
  );

  const endpoint = await findEndpoint(id);
  if (!endpoint) throw ApiError.notFound('Notification endpoint could not be re-read.', 'ENDPOINT_NOT_FOUND');

  await audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'admin_endpoint_added',
    entityType: 'admin_endpoint',
    entityId: id,
    summary: `Added a ${data.channel} notification endpoint awaiting ownership verification.`,
    metadata: { optInRecordedAt: timestamp },
  });

  const verification = await requestEndpointVerification(endpoint, user);
  return { endpoint: endpointDto(endpoint, { revealPhone: true }), verification };
}

export async function confirmEndpointVerification(
  endpoint: AdminEndpointRow,
  code: string,
  user: SafeUser,
): Promise<EndpointDto> {
  if (endpoint.verified_at) return endpointDto(endpoint, { revealPhone: true });

  const verification = await db.one<EndpointVerificationRow>(
    `SELECT * FROM endpoint_verifications WHERE endpoint_id = ? AND consumed_at IS NULL ORDER BY requested_at DESC LIMIT 1`,
    endpoint.id,
  );
  if (!verification || new Date(verification.expires_at).getTime() < Date.now()) {
    throw new ApiError(410, 'This code has expired. Request a new verification code.', 'ENDPOINT_CODE_EXPIRED');
  }
  if (Number(verification.attempts) >= MAX_CODE_ATTEMPTS) {
    throw new ApiError(
      429,
      'Too many attempts for this code. Request a fresh verification code.',
      'ENDPOINT_CODE_LOCKED',
    );
  }

  await db.run('UPDATE endpoint_verifications SET attempts = attempts + 1 WHERE id = ?', verification.id);

  const expectedHash = lookupHash(`endpoint-verification:${endpoint.id}:${code}`);
  const storedHash = verification.code_hash ?? '';
  const codeMatches =
    verification.provider === 'termii_otp'
      ? await verifyTermiiOtp(verification.provider_message_id, code)
      : Buffer.byteLength(expectedHash) === Buffer.byteLength(storedHash) &&
        crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(storedHash));
  if (!codeMatches) throw ApiError.unauthorized('That verification code is not correct.', 'INVALID_ENDPOINT_CODE');

  const timestamp = nowIso();
  await db.transaction(async (tx) => {
    await tx.run('UPDATE endpoint_verifications SET consumed_at = ? WHERE id = ?', timestamp, verification.id);
    await tx.run(
      'UPDATE admin_endpoints SET verified_at = ?, updated_at = ? WHERE id = ?',
      timestamp,
      timestamp,
      endpoint.id,
    );
  });

  const verified = await findEndpoint(endpoint.id);
  await audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'endpoint_ownership_verified',
    entityType: 'admin_endpoint',
    entityId: endpoint.id,
    summary: `Verified ownership of a ${endpoint.channel} notification endpoint.`,
    metadata: { consentRecordedAt: endpoint.opted_in_at },
  });
  if (!verified) throw ApiError.notFound('Notification endpoint not found.', 'ENDPOINT_NOT_FOUND');
  return endpointDto(verified, { revealPhone: true });
}

export async function updateEndpoint(
  id: string,
  values: { enabled?: boolean; priority?: number },
  user: SafeUser,
): Promise<EndpointDto> {
  const endpoint = await assertManageableEndpoint(id, user);
  if (values.enabled === true && !endpoint.verified_at) {
    throw ApiError.conflict('Verify the endpoint before enabling it.', 'ENDPOINT_VERIFICATION_REQUIRED');
  }
  await db.run(
    `UPDATE admin_endpoints SET enabled = COALESCE(?, enabled), priority = COALESCE(?, priority), updated_at = ? WHERE id = ?`,
    typeof values.enabled === 'boolean' ? values.enabled : null,
    values.priority ?? null,
    nowIso(),
    endpoint.id,
  );
  await audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'admin_endpoint_updated',
    entityType: 'admin_endpoint',
    entityId: endpoint.id,
    summary: 'Updated notification endpoint preferences.',
  });
  const updated = await findEndpoint(endpoint.id);
  if (!updated) throw ApiError.notFound('Notification endpoint not found.', 'ENDPOINT_NOT_FOUND');
  return endpointDto(updated, { revealPhone: true });
}

export { assertManageableEndpoint };
