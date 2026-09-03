import type { JSX } from 'react';
import { navigate, segmentsOf, useLocation } from './router.js';
import { useSession } from './session.js';
import { AppShell } from './AppShell.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { InvitationPage } from '../features/auth/InvitationPage.js';
import { DashboardPage } from '../features/dashboard/DashboardPage.js';
import { BirthdaysPage } from '../features/birthdays/BirthdaysPage.js';
import { MembersPage } from '../features/members/MembersPage.js';
import { NotificationsPage } from '../features/notifications/NotificationsPage.js';
import { EndpointsPage } from '../features/endpoints/EndpointsPage.js';
import { ImportsPage } from '../features/imports/ImportsPage.js';
import { AuditPage } from '../features/audit/AuditPage.js';
import { StaffPage } from '../features/staff/StaffPage.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';
import { Button, EmptyState } from '../components/ui.js';
import { IconSearch } from '../components/Icons.js';

/**
 * Route table.
 *
 * `/invite/:token` and `/login` are standalone screens; everything else renders
 * inside the application shell once a session exists.
 */
export function App(): JSX.Element {
  const location = useLocation();
  const session = useSession();
  const segments = segmentsOf(location);

  if (segments[0] === 'invite') {
    return <InvitationPage token={segments[1] ?? ''} />;
  }

  if (segments[0] === 'login' || session.status === 'anonymous') {
    return <LoginPage />;
  }

  if (session.status === 'loading') {
    return (
      <div className="standalone" role="status" aria-busy="true">
        <span className="sr-only">Signing you in</span>
        <div className="loading-stack" style={{ width: 'min(420px, 100%)' }}>
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-row" />
          <span className="skeleton skeleton-row" />
        </div>
      </div>
    );
  }

  return <AppShell>{renderRoute(location)}</AppShell>;
}

function renderRoute(path: string): JSX.Element {
  const [first] = segmentsOf(path);
  switch (first) {
    case undefined:
      return <DashboardPage />;
    case 'birthdays':
      return <BirthdaysPage />;
    case 'members':
      return <MembersPage />;
    case 'notifications':
      return <NotificationsPage />;
    case 'endpoints':
      return <EndpointsPage />;
    case 'imports':
      return <ImportsPage />;
    case 'audit':
      return <AuditPage />;
    case 'staff':
      return <StaffPage />;
    case 'settings':
      return <SettingsPage />;
    default:
      return <NotFoundPage path={path} />;
  }
}

function NotFoundPage({ path }: { path: string }): JSX.Element {
  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">404</span>
          <h1>Page not found</h1>
          <p>Nothing is served at {path}.</p>
        </div>
      </header>
      <section className="surface-card">
        <EmptyState
          icon={<IconSearch />}
          title="That page does not exist"
          description="The link may be out of date. Return to the dashboard and use the navigation instead."
          action={
            <Button variant="primary" onClick={() => navigate('/')}>
              Back to the dashboard
            </Button>
          }
        />
      </section>
    </>
  );
}
