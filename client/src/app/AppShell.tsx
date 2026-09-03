import { useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { birthdays } from '../api/index.js';
import { useAsync } from '../hooks/useAsync.js';
import { useTheme } from '../hooks/useTheme.js';
import { Avatar } from '../components/ui.js';
import {
  IconBell,
  IconCake,
  IconDashboard,
  IconDroplet,
  IconLogOut,
  IconMenu,
  IconMessage,
  IconMoon,
  IconSettings,
  IconShield,
  IconSun,
  IconUpload,
  IconUsers,
} from '../components/Icons.js';
import { Link, navigate, useLocation } from './router.js';
import { useSession } from './session.js';
import { initials, lagosToday, formatDate } from '../lib/format.js';
import { useToasts } from '../components/Toasts.js';

interface NavItem {
  path: string;
  label: string;
  section: 'Workspace' | 'Data' | 'Administration';
  icon: (props: { size?: number }) => JSX.Element;
  visible: boolean;
}

export interface PageProps {
  title: string;
  description?: string;
  children: ReactNode;
}

/**
 * Application frame: skip link, sidebar, mobile drawer, top bar and the routed
 * page. Navigation is derived from the signed-in role so people are never
 * shown a destination that will answer 403.
 */
export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const session = useSession();
  const location = useLocation();
  const toasts = useToasts();
  const theme = useTheme();
  const [navOpen, setNavOpen] = useState(false);

  const today = useAsync(() => birthdays.today(), [session.user?.id], {
    enabled: session.capabilities.canSeeBirthdays,
  });

  useEffect(() => {
    setNavOpen(false);
  }, [location]);

  const birthdayCount = today.data?.items.filter((item) => item.daysUntil === 0).length ?? 0;

  const items: NavItem[] = [
    { path: '/', label: 'Dashboard', section: 'Workspace', icon: IconDashboard, visible: true },
    {
      path: '/birthdays',
      label: 'Birthdays',
      section: 'Workspace',
      icon: IconCake,
      visible: session.capabilities.canSeeBirthdays,
    },
    { path: '/notifications', label: 'Delivery log', section: 'Workspace', icon: IconBell, visible: true },
    {
      path: '/endpoints',
      label: 'My endpoints',
      section: 'Workspace',
      icon: IconMessage,
      visible: session.user?.role !== 'auditor',
    },
    {
      path: '/members',
      label: 'Members',
      section: 'Data',
      icon: IconUsers,
      visible: session.capabilities.canManageMembers,
    },
    {
      path: '/imports',
      label: 'CSV import',
      section: 'Data',
      icon: IconUpload,
      visible: session.capabilities.canImportMembers,
    },
    {
      path: '/audit',
      label: 'Audit trail',
      section: 'Administration',
      icon: IconShield,
      visible: session.capabilities.canSeeAudit,
    },
    {
      path: '/staff',
      label: 'Staff & access',
      section: 'Administration',
      icon: IconUsers,
      visible: session.capabilities.canManageStaff,
    },
    { path: '/settings', label: 'Settings', section: 'Administration', icon: IconSettings, visible: true },
  ];

  const sections = (['Workspace', 'Data', 'Administration'] as const)
    .map((section) => ({ section, items: items.filter((item) => item.section === section && item.visible) }))
    .filter((group) => group.items.length > 0);

  const signOut = async (): Promise<void> => {
    await session.signOut();
    toasts.info('You have been signed out.');
    navigate('/login');
  };

  const nav = (
    <>
      <div className="sidebar-brand">
        <span className="brand-mark">
          <IconDroplet />
        </span>
        <span>
          <span className="sidebar-brand-name">Living Water</span>
          <span className="sidebar-brand-sub">Birthday Care</span>
        </span>
      </div>

      <nav aria-label="Main">
        {sections.map((group) => (
          <div key={group.section}>
            <p className="sidebar-section-label">{group.section}</p>
            <div className="sidebar-nav">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = item.path === '/' ? location === '/' : location.startsWith(item.path);
                return (
                  <Link key={item.path} to={item.path} className="nav-item" aria-current={active ? 'page' : undefined}>
                    <Icon size={18} />
                    <span>{item.label}</span>
                    {item.path === '/birthdays' && birthdayCount > 0 ? (
                      <span className="nav-badge" aria-label={`${birthdayCount} birthdays today`}>
                        {birthdayCount}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button type="button" className="user-chip" onClick={() => navigate('/settings')}>
          <Avatar initials={initials(session.user?.fullName ?? '?')} size="sm" label={session.user?.fullName ?? ''} />
          <span>
            <strong>{session.user?.fullName}</strong>
            <small>{session.roleLabel || session.user?.role}</small>
          </span>
        </button>
        <button type="button" className="nav-item" style={{ width: '100%' }} onClick={() => void signOut()}>
          <IconLogOut size={18} />
          <span>Sign out</span>
        </button>
      </div>
    </>
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <aside className="sidebar">{nav}</aside>

      <div className="mobile-nav" data-open={navOpen} aria-hidden={!navOpen}>
        <div className="mobile-nav-backdrop" onClick={() => setNavOpen(false)} />
        <div className="mobile-nav-panel" id="mobile-navigation">
          {nav}
        </div>
      </div>

      <div className="main-area">
        <header className="topbar">
          <button
            type="button"
            className="icon-button mobile-menu-button"
            onClick={() => setNavOpen((open) => !open)}
            aria-expanded={navOpen}
            aria-controls="mobile-navigation"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          >
            <IconMenu />
          </button>

          <div className="topbar-title">
            <h1>Birthday Care</h1>
            <p>{formatDate(lagosToday())} · Africa/Lagos</p>
          </div>

          <div className="topbar-user">
            <button
              type="button"
              className="icon-button"
              onClick={() => theme.setPreference(theme.resolved === 'dark' ? 'light' : 'dark')}
              aria-label={theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme.resolved === 'dark' ? <IconSun /> : <IconMoon />}
            </button>
            <Avatar initials={initials(session.user?.fullName ?? '?')} size="sm" label={session.user?.fullName ?? ''} />
            <span className="topbar-user-name">
              <strong>{session.user?.fullName}</strong>
              <br />
              {session.roleLabel}
            </span>
          </div>
        </header>

        <main id="main-content" className="page-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
