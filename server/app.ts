import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import type { Express, Request } from 'express';
import { config } from './config.js';
import { corsMiddleware, createSessionMiddleware, csrfProtection } from './http/session.js';
import { errorHandler, notFoundHandler } from './http/error-handler.js';
import { apiLimiter } from './http/rate-limits.js';
import { requestLogger } from './http/request-log.js';
import { authRouter } from './routes/auth.js';
import { invitationsRouter } from './routes/invitations.js';
import { membersRouter } from './routes/members.js';
import { birthdaysRouter } from './routes/birthdays.js';
import { notificationsRouter } from './routes/notifications.js';
import { settingsRouter } from './routes/settings.js';
import { endpointsRouter } from './routes/endpoints.js';
import { staffRouter } from './routes/staff.js';
import { importsRouter } from './routes/imports.js';
import { auditRouter } from './routes/audit.js';
import { dashboardRouter } from './routes/dashboard.js';
import { webhooksRouter } from './routes/webhooks.js';
import { healthRouter } from './routes/health.js';

/** Compiled assets live in the project's `client/dist` directory. */
const distDirectory = path.resolve(process.cwd(), 'client/dist');

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: config.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              baseUri: ["'self'"],
              connectSrc: ["'self'"],
              fontSrc: ["'self'"],
              formAction: ["'self'"],
              frameAncestors: ["'self'"],
              imgSrc: ["'self'", 'data:'],
              objectSrc: ["'none'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'"],
              upgradeInsecureRequests: [],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(requestLogger);
  app.use(corsMiddleware);
  app.use(
    express.json({
      limit: '700kb',
      verify: (req, _res, buffer) => {
        (req as Request).rawBody = buffer;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '80kb' }));
  app.use(createSessionMiddleware());

  app.use('/api', csrfProtection);
  app.use('/api', apiLimiter);

  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/invitations', invitationsRouter);
  app.use('/api/members', membersRouter);
  app.use('/api/birthdays', birthdaysRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/endpoints', endpointsRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/imports', importsRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/health', healthRouter);

  app.use('/api', notFoundHandler);

  if (fs.existsSync(distDirectory)) {
    app.use(express.static(distDirectory, { index: false, maxAge: config.isProduction ? '1h' : 0 }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(distDirectory, 'index.html')));
  } else {
    app.get('/{*splat}', (_req, res) =>
      res.status(503).send('Frontend has not been built. Run `npm run build:client` first.'),
    );
  }

  app.use(errorHandler);
  return app;
}

export { distDirectory };
