import crypto from 'node:crypto';
import { Router } from 'express';
import { ApiError } from '../errors.js';
import { applyProviderStatus } from '../notification-pg.js';
import { verifyMetaSignature, verifyMetaSubscription, verifyTermiiSignature } from '../services/webhooks.js';

export const webhooksRouter = Router();

interface WhatsAppStatus {
  id?: string;
  status?: string;
}

interface WhatsAppEntry {
  changes?: Array<{ value?: { statuses?: WhatsAppStatus[] } }>;
}

webhooksRouter.get('/whatsapp', (req, res) => {
  if (!verifyMetaSubscription(req)) {
    res.sendStatus(403);
    return;
  }
  const challenge = req.query['hub.challenge'];
  res.status(200).send(typeof challenge === 'string' ? challenge : '');
});

webhooksRouter.post('/whatsapp', async (req, res) => {
  if (!verifyMetaSignature(req)) {
    throw ApiError.unauthorized('Webhook signature verification failed.', 'INVALID_WEBHOOK_SIGNATURE');
  }
  const body = (req.body ?? {}) as { entry?: WhatsAppEntry[] };
  const statuses = (body.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .flatMap((change) => change?.value?.statuses ?? []);
  for (const status of statuses) {
    await applyProviderStatus({
      provider: 'meta',
      providerMessageId: status.id ?? null,
      status: status.status ?? 'provider_accepted',
      eventHash: crypto.createHash('sha256').update(JSON.stringify(status)).digest('hex'),
      eventType: 'whatsapp_status',
    });
  }
  res.sendStatus(200);
});

webhooksRouter.post('/sms', async (req, res) => {
  if (!verifyTermiiSignature(req)) {
    throw ApiError.unauthorized('Termii webhook signature verification failed.', 'INVALID_WEBHOOK_SIGNATURE');
  }
  const body = (req.body ?? {}) as { status?: string; message_id?: string; message_id_str?: string; id?: string };
  const rawStatus = String(body.status ?? '').toLowerCase();
  const status = rawStatus.includes('deliver')
    ? 'delivered'
    : /fail|dnd|reject|expired/.test(rawStatus)
      ? 'failed'
      : rawStatus.includes('sent')
        ? 'sent'
        : 'provider_accepted';

  await applyProviderStatus({
    provider: 'termii',
    providerMessageId: body.message_id ?? body.message_id_str ?? body.id ?? null,
    status,
    eventHash: crypto
      .createHash('sha256')
      .update(req.rawBody ?? Buffer.from(JSON.stringify(body)))
      .digest('hex'),
    eventType: 'sms_delivery_report',
  });
  res.sendStatus(200);
});
