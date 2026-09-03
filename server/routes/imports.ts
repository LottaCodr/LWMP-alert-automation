import { Router } from 'express';
import { requireAuth, requireRoles, sessionUser } from '../http/guards.js';
import { commitImport, previewImport } from '../services/imports.js';

export const importsRouter = Router();

importsRouter.use(requireAuth, requireRoles('owner', 'membership_officer'));

importsRouter.post('/preview', async (req, res) => {
  res.json(await previewImport((req.body as { csvText?: unknown })?.csvText));
});

importsRouter.post('/commit', async (req, res) => {
  const result = await commitImport((req.body as { rows?: unknown })?.rows, sessionUser(req));
  res.status(201).json(result);
});
