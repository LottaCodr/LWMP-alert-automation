/**
 * Shared presentational primitives.
 *
 * Every interactive element here keeps a visible focus indicator, a minimum
 * 24×24 CSS px target (WCAG 2.5.8) and an accessible name.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, JSX, ReactNode, SelectHTMLAttributes } from 'react';
import { IconAlert } from './Icons.js';
import type { Tone } from '../lib/status.js';

/* --- Buttons ------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger' | 'on-inverse';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  full?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  full = false,
  icon,
  children,
  className = '',
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    'button',
    `button-${variant}`,
    size === 'sm' ? 'button-sm' : '',
    full ? 'button-full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="button-spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

export function TextAction({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button type="button" className="text-action" {...rest}>
      {children}
    </button>
  );
}

/* --- Badges ------------------------------------------------------- */

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/* --- Avatar ------------------------------------------------------- */

export function Avatar({
  initials,
  size = 'md',
  label,
}: {
  initials: string;
  size?: 'sm' | 'md' | 'lg';
  label: string;
}): JSX.Element {
  const sizeClass = size === 'sm' ? 'avatar-sm' : size === 'lg' ? 'avatar-lg' : '';
  return (
    <span className={`avatar ${sizeClass}`.trim()} role="img" aria-label={label}>
      {initials}
    </span>
  );
}

/* --- Form fields -------------------------------------------------- */

export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  optional?: boolean;
  children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, required, optional, children }: FieldProps): JSX.Element {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        <span>
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
          {optional ? <span className="optional"> (optional)</span> : null}
        </span>
        {required ? <span className="sr-only">required</span> : null}
      </label>
      {children}
      {error ? (
        <p className="field-error" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Extra element ids to announce alongside the hint or error. */
  describedByExtra?: string;
}

/** Attaches the describedby ids the surrounding `Field` renders. */
export function TextInput({ invalid, id, describedByExtra, className = '', ...rest }: TextInputProps): JSX.Element {
  const describedBy = [invalid ? `${id}-error` : `${id}-hint`, describedByExtra].filter(Boolean).join(' ');
  return (
    <input
      id={id}
      className={`field-control ${className}`.trim()}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy || undefined}
      {...rest}
    />
  );
}

export interface SelectInputProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  options: Array<{ value: string; label: string }>;
}

export function SelectInput({ invalid, id, options, className = '', ...rest }: SelectInputProps): JSX.Element {
  const describedBy = [invalid ? `${id}-error` : `${id}-hint`].filter(Boolean).join(' ');
  return (
    <select
      id={id}
      className={`field-control ${className}`.trim()}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy || undefined}
      {...rest}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/* --- Switch ------------------------------------------------------- */

export interface SwitchProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function Switch({ id, checked, onChange, label, disabled, size = 'md' }: SwitchProps): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${size === 'sm' ? 'switch-sm' : ''}`.trim()}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}

/* --- Feedback ----------------------------------------------------- */

export interface EmptyStateProps {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="empty-state">
      {icon ? <span className="empty-icon">{icon}</span> : null}
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export interface ErrorPanelProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  details?: ReactNode;
}

export function ErrorPanel({
  title = 'Something went wrong',
  message,
  onRetry,
  details,
}: ErrorPanelProps): JSX.Element {
  return (
    <div className="error-panel" role="alert">
      <IconAlert />
      <div>
        <h2>{title}</h2>
        <p>{message}</p>
        {details}
        {onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry} style={{ marginTop: 12 }}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function Skeleton({ className = '', label }: { className?: string; label: string }): JSX.Element {
  return <span className={`skeleton ${className}`.trim()} role="presentation" aria-label={label} />;
}

/** Placeholder rows that match the real row height so nothing jumps on load. */
export function TableSkeleton({ rows = 6, caption }: { rows?: number; caption: string }): JSX.Element {
  return (
    <div className="loading-stack" role="status" aria-busy="true">
      <span className="sr-only">{caption}</span>
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="skeleton skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}

export function LastUpdated({ timestamp }: { timestamp: number | null }): JSX.Element | null {
  if (!timestamp) return null;
  return (
    <span>
      Updated{' '}
      <time dateTime={new Date(timestamp).toISOString()}>{new Date(timestamp).toLocaleTimeString('en-GB')}</time>
    </span>
  );
}

/* --- Cards -------------------------------------------------------- */

export interface CardProps {
  title: string;
  description?: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}

export function Card({ title, description, eyebrow, action, children, padded = true }: CardProps): JSX.Element {
  return (
    <section className="surface-card">
      <div className="card-heading">
        <div>
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <h2>{title}</h2>
          {description ? (
            <p className="muted" style={{ marginTop: 4, fontSize: 'var(--text-xs)' }}>
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      {padded ? <div className="card-body">{children}</div> : children}
    </section>
  );
}
