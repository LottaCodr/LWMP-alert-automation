import { Router } from 'express';
import { requireAuth, sessionUser } from '../http/guards.js';
import { dashboardFor } from '../services/dashboard.js';

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get('/', async (req, res) => {
  res.json(await dashboardFor(sessionUser(req)));
});
