import crypto from 'node:crypto';
import type { Request } from 'express';
import { config, webhookVerifyToken } from '../config.js';

/**
 * Provider webhook signature verification.
 *
 * Both providers sign the raw request body, so `rawBody` is captured by the JSON
 * body parser before parsing. In production a missing secret fails closed; in
 * development it is permissive so the mock flow stays testable.
 */

export function verifyMetaSignature(req: Request): boolean {
  const appSecret = config.META_APP_SECRET;
  if (!appSecret) return !config.isProduction;

  const signature = req.get('x-hub-signature-256');
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody ?? Buffer.from(''))
    .digest('hex')}`;
  return timingSafeEqualStrings(signature, expected);
}

export function verifyTermiiSignature(req: Request): boolean {
  const secret = config.TERMII_WEBHOOK_SECRET;
  if (!secret) return !config.isProduction;

  const signature = req.get('x-termii-signature');
  if (!signature || !/^[a-f0-9]{128}$/i.test(signature)) return false;
  const expected = crypto
    .createHmac('sha512', secret)
    .update(req.rawBody ?? Buffer.from(''))
    .digest('hex');
  const provided = Buffer.from(signature.toLowerCase(), 'hex');
  const actual = Buffer.from(expected, 'hex');
  return provided.length === actual.length && crypto.timingSafeEqual(provided, actual);
}

export function verifyMetaSubscription(req: Request): boolean {
  return req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === webhookVerifyToken;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
