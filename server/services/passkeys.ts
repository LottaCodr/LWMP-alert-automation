import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Request } from 'express';
import { ApiError } from '../errors.js';
import { audit, db, newId, nowIso } from '../database-pg.js';
import { saveRequestSession } from '../http/session.js';
import { getUserById, webAuthnConfiguration } from '../http/guards.js';
import type { PasskeyCeremony, PasskeyRow, UserRow } from '../types.js';

const CEREMONY_LIFETIME_MS = 120_000;
const RP_NAME = 'Living Water Mega Parish Birthday Care';

type SessionKey = 'passkeyAuthentication' | 'passkeyMfaAuthentication' | 'passkeyRegistration';

function validCeremony(ceremony: PasskeyCeremony | undefined): ceremony is PasskeyCeremony {
  if (!ceremony) return false;
  return new Date(ceremony.expiresAt).getTime() > Date.now();
}

function credentialForVerification(row: PasskeyRow) {
  return {
    id: row.credential_id,
    publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
    counter: Number(row.counter || 0),
    transports: JSON.parse(row.transports || '[]') as Array<'usb' | 'nfc' | 'ble' | 'internal'>,
  };
}

export async function beginPasskeyAuthentication(
  req: Request,
  user: UserRow,
  key: 'passkeyAuthentication' | 'passkeyMfaAuthentication' = 'passkeyAuthentication',
) {
  const credentials = await db.all<PasskeyRow>(
    'SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at ASC',
    user.id,
  );
  if (!credentials.length) {
    throw ApiError.unprocessable(
      'No passkey is enrolled for this account. Use your authenticator app instead.',
      'PASSKEY_NOT_ENROLLED',
    );
  }
  const { origin, rpID } = webAuthnConfiguration(req);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credential_id,
      transports: JSON.parse(credential.transports || '[]') as Array<'usb' | 'nfc' | 'ble' | 'internal'>,
    })),
    userVerification: 'required',
    timeout: 60_000,
  });
  req.session[key] = {
    challenge: options.challenge,
    userId: user.id,
    origin,
    rpID,
    expiresAt: new Date(Date.now() + CEREMONY_LIFETIME_MS).toISOString(),
  };
  await saveRequestSession(req);
  return options;
}

export async function completePasskeyAuthentication(
  req: Request,
  response: AuthenticationResponseJSON | undefined,
  key: 'passkeyAuthentication' | 'passkeyMfaAuthentication' = 'passkeyAuthentication',
): Promise<UserRow> {
  const ceremony = req.session?.[key];
  if (!validCeremony(ceremony)) {
    throw ApiError.unauthorized('This passkey request has expired. Start again.', 'PASSKEY_CHALLENGE_EXPIRED');
  }
  const user = await getUserById(ceremony.userId);
  if (!user) throw ApiError.unauthorized('This staff account is no longer active.');

  const passkey = await db.one<PasskeyRow>(
    'SELECT * FROM passkeys WHERE credential_id = ? AND user_id = ?',
    String(response?.id ?? ''),
    user.id,
  );
  if (!passkey) {
    throw ApiError.unauthorized('This passkey is not recognised for the requested account.', 'PASSKEY_NOT_RECOGNISED');
  }

  if (!response) {
    throw ApiError.unprocessable(
      'The browser did not return a passkey response. Try again.',
      'PASSKEY_VERIFICATION_FAILED',
    );
  }

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
  } catch {
    throw ApiError.unauthorized(
      'Passkey verification failed. Try again or use another sign-in method.',
      'PASSKEY_VERIFICATION_FAILED',
    );
  }
  if (!verification.verified) {
    throw ApiError.unauthorized('Passkey verification failed. Try again.', 'PASSKEY_VERIFICATION_FAILED');
  }

  await db.run(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?',
    verification.authenticationInfo.newCounter,
    nowIso(),
    passkey.id,
  );
  return user;
}

export async function beginPasskeyRegistration(req: Request, user: UserRow) {
  const credentials = await db.all<PasskeyRow>(
    'SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at ASC',
    user.id,
  );
  const { origin, rpID } = webAuthnConfiguration(req);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: Buffer.from(user.id),
    userName: user.email,
    userDisplayName: user.full_name,
    attestationType: 'none',
    timeout: 60_000,
    excludeCredentials: credentials.map((credential) => ({
      id: credential.credential_id,
      transports: JSON.parse(credential.transports || '[]') as Array<'usb' | 'nfc' | 'ble' | 'internal'>,
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  req.session.passkeyRegistration = {
    challenge: options.challenge,
    userId: user.id,
    origin,
    rpID,
    expiresAt: new Date(Date.now() + CEREMONY_LIFETIME_MS).toISOString(),
  };
  await saveRequestSession(req);
  return options;
}

export async function completePasskeyRegistration(
  req: Request,
  response: RegistrationResponseJSON | undefined,
  userId: string,
): Promise<UserRow> {
  const ceremony = req.session?.passkeyRegistration;
  if (!validCeremony(ceremony) || ceremony.userId !== userId) {
    throw ApiError.unauthorized(
      'This passkey enrollment request has expired. Start again.',
      'PASSKEY_CHALLENGE_EXPIRED',
    );
  }

  if (!response) {
    throw ApiError.unprocessable(
      'The browser did not return a passkey response. Try again.',
      'PASSKEY_VERIFICATION_FAILED',
    );
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpID,
      requireUserVerification: true,
    });
  } catch {
    throw ApiError.unprocessable('Passkey enrollment could not be verified. Try again.', 'PASSKEY_VERIFICATION_FAILED');
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw ApiError.unprocessable('Passkey enrollment could not be verified. Try again.', 'PASSKEY_VERIFICATION_FAILED');
  }

  const info = verification.registrationInfo;
  const timestamp = nowIso();
  const transports = Array.isArray(response?.response?.transports) ? response.response.transports : [];

  try {
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('passkey_'),
        userId,
        info.credential.id,
        Buffer.from(info.credential.publicKey).toString('base64url'),
        info.credential.counter,
        JSON.stringify(transports),
        info.credentialDeviceType,
        info.credentialBackedUp,
        timestamp,
      );
      await tx.run(
        `UPDATE users SET passkey_enrolled_at = COALESCE(passkey_enrolled_at, ?), mfa_required = TRUE, mfa_state = 'passkey_enrolled', updated_at = ? WHERE id = ?`,
        timestamp,
        timestamp,
        userId,
      );
    });
  } catch (error) {
    if (String((error as Error)?.message ?? '').includes('unique')) {
      throw ApiError.conflict('This passkey is already registered to a staff account.', 'PASSKEY_ALREADY_REGISTERED');
    }
    throw error;
  }

  const user = await getUserById(userId);
  if (!user) throw ApiError.unauthorized('This staff account is no longer active.');
  await audit({
    actorId: user.id,
    actorName: user.full_name,
    action: 'passkey_enrollment_completed',
    entityType: 'authentication',
    entityId: user.id,
    summary: 'Enrolled a passkey for staff MFA.',
  });
  return user;
}

export type { SessionKey };
