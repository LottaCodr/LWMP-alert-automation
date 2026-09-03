import { config } from '../config.js';
import { db, decryptValue } from '../database-pg.js';
import { lagosDateParts, toIsoDate } from '../domain/calendar.js';
import { maskPhone } from '../domain/phone.js';
import { getNotificationRuleDto } from '../notification-pg.js';
import { upcomingBirthdays } from './members.js';
import type {
  AppSettingRow,
  CountRow,
  DashboardDto,
  NotificationDto,
  NotificationWithRecipientRow,
  SafeUser,
} from '../types.js';

const DELIVERY_WINDOW_DAYS = 30;

export function notificationDto(row: NotificationWithRecipientRow): NotificationDto {
  return {
    id: row.id,
    notificationKey: row.notification_key,
    userId: row.user_id,
    recipientName: row.recipient_name ?? 'Administrator',
    endpointLabel: row.endpoint_label ?? 'Notification endpoint',
    endpointMasked: maskPhone(decryptValue(row.phone_encrypted)),
    channel: row.channel,
    type: row.notification_type,
    scheduledFor: row.scheduled_for,
    messagePreview: row.message_preview,
    memberCount: Number(row.member_count),
    status: row.status,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    attempts: Number(row.attempts),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    lastEventAt: row.last_event_at,
  };
}

export async function getNotifications(user: SafeUser, limit: string | number = 40): Promise<NotificationDto[]> {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const query = `
    SELECT n.*, u.full_name AS recipient_name, endpoint.label AS endpoint_label, endpoint.phone_encrypted
      FROM notifications n
      INNER JOIN users u ON u.id = n.user_id
      INNER JOIN admin_endpoints endpoint ON endpoint.id = n.endpoint_id
      ${user.role === 'owner' ? '' : 'WHERE n.user_id = ?'}
     ORDER BY n.created_at DESC LIMIT ?`;
  const rows =
    user.role === 'owner'
      ? await db.all<NotificationWithRecipientRow>(query, safeLimit)
      : await db.all<NotificationWithRecipientRow>(query, user.id, safeLimit);
  return rows.map(notificationDto);
}

interface DeliveryAggregateRow {
  total: number;
  delivered: number;
  failed: number;
}

export async function dashboardFor(user: SafeUser): Promise<DashboardDto> {
  const today = lagosDateParts();
  const windowStart = new Date(Date.now() - DELIVERY_WINDOW_DAYS * 86_400_000).toISOString();

  const [upcoming, activeRow, healthRow, deliveryRow, parishRow] = await Promise.all([
    upcomingBirthdays(user, 14),
    db.one<CountRow>(`SELECT COUNT(*)::int AS count FROM members WHERE status = 'active'`),
    db.one<{ issues: number }>(
      `SELECT COUNT(*) FILTER (WHERE phone_encrypted IS NULL OR consent_status = 'review_required')::int AS issues
         FROM members WHERE status = 'active'`,
    ),
    user.role === 'owner'
      ? db.one<DeliveryAggregateRow>(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status IN ('delivered','read'))::int AS delivered,
                  COUNT(*) FILTER (WHERE status IN ('failed','dead_letter'))::int AS failed
             FROM notifications WHERE created_at >= ?`,
          windowStart,
        )
      : db.one<DeliveryAggregateRow>(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status IN ('delivered','read'))::int AS delivered,
                  COUNT(*) FILTER (WHERE status IN ('failed','dead_letter'))::int AS failed
             FROM notifications WHERE user_id = ? AND created_at >= ?`,
          user.id,
          windowStart,
        ),
    db.one<AppSettingRow>(`SELECT * FROM app_settings WHERE setting_key = 'parish_profile'`),
  ]);

  const total = Number(deliveryRow?.total ?? 0);
  const delivered = Number(deliveryRow?.delivered ?? 0);

  return {
    date: toIsoDate(today),
    parish: parseParishProfile(parishRow),
    rule: await getNotificationRuleDto(),
    stats: {
      activeMembers: Number(activeRow?.count ?? 0),
      todaysBirthdays: upcoming.filter((item) => item.daysUntil === 0).length,
      nextSevenDays: upcoming.filter((item) => item.daysUntil <= 7).length,
      deliveryRate: total ? Math.round((delivered / total) * 100) : null,
      failedDeliveries: Number(deliveryRow?.failed ?? 0),
      dataHealthIssues: Number(healthRow?.issues ?? 0),
    },
    todaysBirthdays: upcoming.filter((item) => item.daysUntil === 0),
    upcoming: upcoming.slice(0, 7),
    recentNotifications: await getNotifications(user, 5),
  };
}

function parseParishProfile(row: AppSettingRow | null): Record<string, unknown> {
  const fallback = {
    parishName: 'Living Water Mega Parish – RCCG',
    environment: config.isProduction ? 'production' : 'demo',
  };
  if (!row?.setting_value) return fallback;
  try {
    const parsed: unknown = JSON.parse(row.setting_value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : fallback;
  } catch {
    return fallback;
  }
}
