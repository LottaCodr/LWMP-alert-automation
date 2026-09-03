/**
 * Inline SVG icon set.
 *
 * Icons inherit `currentColor`, are 24×24 with a 1.7px stroke, and always carry
 * `aria-hidden` — the label belongs to the adjacent text, never the glyph
 * (WCAG 4.1.2).
 */
import type { JSX, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="icon"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </Icon>
);

export const IconUsers = (props: IconProps) => (
  <Icon {...props}>
    <path d="M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20" />
    <circle cx="10" cy="8" r="3.2" />
    <path d="M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 5.1a3.2 3.2 0 0 1 0 5.8" />
  </Icon>
);

export const IconCake = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 20h16v-4.5a2.5 2.5 0 0 0-2.5-2.5h-11A2.5 2.5 0 0 0 4 15.5V20Z" />
    <path d="M4 17.2c1.6 0 1.6-1.2 3.2-1.2s1.6 1.2 3.2 1.2 1.6-1.2 3.2-1.2 1.6 1.2 3.2 1.2 1.6-1.2 3.2-1.2" />
    <path d="M12 13V9" />
    <path d="M12 6.6c1.1-.9 1.1-1.9 0-3.1-1.1 1.2-1.1 2.2 0 3.1Z" />
  </Icon>
);

export const IconBell = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 9a6 6 0 0 1 12 0c0 4 1.3 5.4 1.9 6H4.1C4.7 14.4 6 13 6 9Z" />
    <path d="M10 18.5a2.2 2.2 0 0 0 4 0" />
  </Icon>
);

export const IconMessage = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 12.5A7.5 7.5 0 0 1 12.5 20H9l-4.5 2 1-3.6A7.5 7.5 0 0 1 12.5 5 7.5 7.5 0 0 1 20 12.5Z" />
    <path d="M9 11.5h6M9 14.5h4" />
  </Icon>
);

export const IconUpload = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 16V4.5M12 4.5 8 8.5M12 4.5 16 8.5" />
    <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
  </Icon>
);

export const IconShield = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3.5 5.5 6v5.4c0 4 2.7 7.6 6.5 9.1 3.8-1.5 6.5-5.1 6.5-9.1V6L12 3.5Z" />
    <path d="m9.2 12 2 2 3.6-3.8" />
  </Icon>
);

export const IconSettings = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.8 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.4Z" />
  </Icon>
);

export const IconLogOut = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3" />
    <path d="M15.5 16.5 20 12l-4.5-4.5M20 12H9.5" />
  </Icon>
);

export const IconMenu = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const IconSearch = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-3.6-3.6" />
  </Icon>
);

export const IconPlus = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconCheck = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const IconClose = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const IconAlert = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10.3 4.3 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Icon>
);

export const IconInfo = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </Icon>
);

export const IconChevronLeft = (props: IconProps) => (
  <Icon {...props}>
    <path d="m14.5 5.5-7 6.5 7 6.5" />
  </Icon>
);

export const IconChevronRight = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9.5 5.5 7 6.5-7 6.5" />
  </Icon>
);

export const IconSort = (props: IconProps) => (
  <Icon {...props}>
    <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
  </Icon>
);

export const IconRefresh = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20 4v4.5h-4.5" />
  </Icon>
);

export const IconDownload = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4v11M12 15l-4-4M12 15l4-4" />
    <path d="M4 18.5h16" />
  </Icon>
);

export const IconEye = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Icon>
);

export const IconEyeOff = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.9 5.9A9.4 9.4 0 0 1 12 5.8c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-2.8 3.6M6.4 7.8A16.6 16.6 0 0 0 2.5 12s3.5 6.2 9.5 6.2a9.6 9.6 0 0 0 3.6-.7" />
    <path d="M10.1 10.1a2.8 2.8 0 0 0 3.9 3.9M3 3l18 18" />
  </Icon>
);

export const IconKey = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="14" r="3.5" />
    <path d="m10.7 11.6 8-8M16.4 5.9l2.2 2.2M14.2 8.1l2.2 2.2" />
  </Icon>
);

export const IconFingerprint = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6.5 19.5A11 11 0 0 0 8 12a4 4 0 0 1 8 0 9 9 0 0 1-.6 3.2" />
    <path d="M12 20a9.6 9.6 0 0 0 2-5.4A2 2 0 0 0 12 13a2 2 0 0 0-2 2c0 1.2-.2 2.4-.6 3.5" />
    <path d="M4.2 8.6A9 9 0 0 1 12 4a9 9 0 0 1 7.9 4.7" />
    <path d="M15.9 20.4A13 13 0 0 0 18 12a6 6 0 0 0-1.6-4.1" />
  </Icon>
);

export const IconSun = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
  </Icon>
);

export const IconMoon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z" />
  </Icon>
);

export const IconClock = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 1.8" />
  </Icon>
);

export const IconMail = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="5.5" width="18" height="13" rx="2" />
    <path d="m3.8 7 7.1 5.2a2 2 0 0 0 2.2 0L20.2 7" />
  </Icon>
);

export const IconCopy = (props: IconProps) => (
  <Icon {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
  </Icon>
);

export const IconTrash = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
  </Icon>
);

export const IconArchive = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4.5" width="18" height="4" rx="1.5" />
    <path d="M5 8.5v10A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-10" />
    <path d="M10 12.5h4" />
  </Icon>
);

export const IconCalendar = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
    <path d="M3.5 10h17M8 3.5V6.5M16 3.5V6.5" />
  </Icon>
);

export const IconSparkle = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9L4.5 10.8 10.2 9 12 3.5Z" />
    <path d="M18.5 16.5 19.3 19l2.2.8-2.2.8-.8 2.2" />
  </Icon>
);

export const IconDroplet = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3.2c3.2 3.6 6 6.6 6 9.6a6 6 0 0 1-12 0c0-3 2.8-6 6-9.6Z" />
    <path d="M9 13.6a3 3 0 0 0 2.6 3" />
  </Icon>
);

export const IconExternal = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14 4h6v6M20 4l-8.5 8.5" />
    <path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
  </Icon>
);

export const IconFile = (props: IconProps) => (
  <Icon {...props}>
    <path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5l-5-5Z" />
    <path d="M13.5 3.5v5h5" />
  </Icon>
);

export const IconLock = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4.5" y="10" width="15" height="10.5" rx="2" />
    <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
  </Icon>
);
