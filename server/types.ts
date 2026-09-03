import type { Request } from 'express';
import 'express-session';

export type UserRole = 'owner' | 'membership_officer' | 'birthday_coordinator' | 'auditor';
export type DeliveryChannel = 'whatsapp' | 'sms';
export type NotificationStatus = 'scheduled' | 'queued' | 'provider_accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'retrying' | 'dead_letter';

export interface SafeUser {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  groupScope: string[];
  mfaState: string | null;
  mfaRequired: boolean;
  mfaEnrolledAt: string | null;
  passkeyEnrolledAt: string | null;
  active: boolean;
}

export interface AuthenticatedRequest extends Request {
  rawBody?: Buffer;
  user?: SafeUser & { _row?: Record<string, any> };
}

export interface PasskeyCeremony {
  challenge: string;
  userId: string;
  origin: string;
  rpID: string;
  expiresAt: string;
}

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    userId?: string;
    preMfaUserId?: string;
    preMfaStartedAt?: string;
    passkeyAuthentication?: PasskeyCeremony;
    passkeyMfaAuthentication?: PasskeyCeremony;
    passkeyRegistration?: PasskeyCeremony;
  }
}

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      user?: SafeUser & { _row?: Record<string, any> };
    }
  }
}
