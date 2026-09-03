import type { DateParts, DeliveryChannel } from '../types.js';
import { formatLongDate } from './calendar.js';

/**
 * Message copy for outbound alerts.
 *
 * The privacy rule is enforced by construction: a birthday alert carries only a
 * **count** and a direction to the access-controlled dashboard. Names, phone
 * numbers and dates of birth never appear in a lock-screen message.
 */

export function messageForDigest(memberCount: number, birthdayDate: DateParts, daysBefore = 0): string {
  const subject = memberCount === 1 ? '1 authorised birthday is due' : `${memberCount} authorised birthdays are due`;
  const timing =
    daysBefore === 0
      ? `on ${formatLongDate(birthdayDate)}`
      : `in ${daysBefore} day${daysBefore === 1 ? '' : 's'} (${formatLongDate(birthdayDate)})`;
  return `${subject} ${timing}. Sign in to the Living Water private dashboard to view the permitted list.`;
}

export function messageForTest(channel: DeliveryChannel): string {
  const label = channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
  return `Living Water Mega Parish: this is a ${label} delivery test. No member data is included.`;
}

export function endpointVerificationMessage(code: string): string {
  return `Living Water verification code: ${code}. It expires in 10 minutes. Do not share this code.`;
}
