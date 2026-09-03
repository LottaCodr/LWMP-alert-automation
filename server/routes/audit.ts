import { Router } from 'express';
import { db } from '../database-pg.js';
import { requireAuth, requireRoles } from '../http/guards.js';
import type { AuditEventDto, AuditEventRow } from '../types.js';

export const auditRouter = Router();

auditRouter.use(requireAuth, requireRoles('owner', 'auditor'));

auditRouter.get('/', async (req, res) => {
  const limit = Math.min(150, Math.max(10, Number(req.query.limit) || 80));
  const rows = await db.all<AuditEventRow>(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?`, limit);
  const items: AuditEventDto[] = rows.map((row) => ({
    id: row.id,
    actorName: row.actor_name,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    createdAt: row.created_at,
  }));
  res.json({ items, limit });
});
