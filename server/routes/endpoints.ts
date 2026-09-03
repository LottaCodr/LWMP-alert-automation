import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { endpointDto } from '../database-pg.js';
import { requireAuth, requireRoles, sessionUser } from '../http/guards.js';
import { endpointVerificationLimiter, mfaLimiter } from '../http/rate-limits.js';
import { normalizeNigerianPhone } from '../domain/phone.js';
import {
  assertManageableEndpoint,
  confirmEndpointVerification,
  createEndpoint,
  endpointCreateSchema,
  endpointUpdateSchema,
  requestEndpointVerification,
  updateEndpoint,
} from '../services/endpoints.js';

export const endpointsRouter = Router();

const verificationCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

endpointsRouter.use(requireAuth, requireRoles('owner', 'membership_officer', 'birthday_coordinator'));

endpointsRouter.post('/', endpointVerificationLimiter, async (req, res) => {
  const parsed = endpointCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.unprocessable(
      'Enter a valid notification endpoint and record its opt-in.',
      'INVALID_ENDPOINT',
      parsed.error.issues,
    );
  }
  const phone = normalizeNigerianPhone(parsed.data.phone);
  if (!phone) {
    throw ApiError.unprocessable(
      'Enter a valid mobile number. Nigerian numbers may be entered as 080… or +234….',
      'INVALID_PHONE',
    );
  }
  const { endpoint, verification } = await createEndpoint(parsed.data, phone, sessionUser(req));
  res.status(201).json({
    endpoint,
    verification,
    message: 'Consent was recorded. Enter the SMS code to prove the number is controlled before alerts can be sent.',
  });
});

endpointsRouter.post('/:id/verification/resend', endpointVerificationLimiter, async (req, res) => {
  const endpoint = await assertManageableEndpoint(String(req.params.id), sessionUser(req));
  if (endpoint.verified_at) throw ApiError.conflict('This endpoint is already verified.', 'ENDPOINT_ALREADY_VERIFIED');
  res.json({
    verification: await requestEndpointVerification(endpoint, sessionUser(req)),
    message: 'A fresh verification code was sent by SMS.',
  });
});

endpointsRouter.post('/:id/verification/confirm', mfaLimiter, async (req, res) => {
  const user = sessionUser(req);
  const endpoint = await assertManageableEndpoint(String(req.params.id), user);
  if (endpoint.verified_at) {
    res.json({ endpoint: endpointDto(endpoint, { revealPhone: true }), message: 'This endpoint is already verified.' });
    return;
  }
  const parsed = verificationCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.unprocessable(
      'Enter the six-digit SMS verification code.',
      'INVALID_ENDPOINT_CODE',
      parsed.error.issues,
    );
  }
  const verified = await confirmEndpointVerification(endpoint, parsed.data.code, user);
  res.json({ endpoint: verified, message: 'Endpoint verified. It is now eligible for the parish notification rule.' });
});

endpointsRouter.patch('/:id', async (req, res) => {
  const parsed = endpointUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.unprocessable('Check the endpoint settings.', 'INVALID_ENDPOINT', parsed.error.issues);
  }
  res.json({ endpoint: await updateEndpoint(String(req.params.id), parsed.data, sessionUser(req)) });
});
