import type { JSX } from 'react';
import type { NotificationStatus } from '../api/types.js';
import { describeNotificationStatus } from '../lib/status.js';
import { Badge } from './ui.js';

/**
 * Delivery status pill.
 *
 * The meaning of each status is documented in a visible legend on the delivery
 * log rather than in a tooltip, so the information is available without hover.
 */
export function NotificationStatusBadge({ status }: { status: NotificationStatus }): JSX.Element {
  const descriptor = describeNotificationStatus(status);
  return <Badge tone={descriptor.tone}>{descriptor.label}</Badge>;
}
