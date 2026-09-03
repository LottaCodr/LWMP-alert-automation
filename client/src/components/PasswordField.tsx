import { useId, useState } from 'react';
import type { JSX } from 'react';
import { Field, TextInput } from './ui.js';
import { IconEye, IconEyeOff } from './Icons.js';
import { assessPassword } from '../lib/password.js';

/**
 * Password input with an inline strength meter.
 *
 * The meter communicates *why* a password is weak instead of only colouring a
 * bar, and the field never blocks paste (WCAG 2.2 SC 3.3.8 — password managers
 * must be usable).
 */
export function PasswordField({
  value,
  onChange,
  label = 'Password',
  autoComplete = 'new-password',
  invalid = false,
  error,
  hint,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  autoComplete?: string;
  invalid?: boolean;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
}): JSX.Element {
  const id = useId();
  const fieldId = `password-${id}`;
  const [visible, setVisible] = useState(false);
  const assessment = assessPassword(value);

  return (
    <Field
      label={label}
      htmlFor={fieldId}
      required
      error={error}
      hint={hint ?? 'At least 12 characters with upper case, lower case and a number.'}
    >
      <div style={{ position: 'relative' }}>
        <TextInput
          id={fieldId}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          invalid={invalid}
          describedByExtra={`${fieldId}-strength`}
          style={{ paddingRight: 48 }}
        />
        <button
          type="button"
          className="icon-button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          style={{ position: 'absolute', right: 4, top: 2 }}
        >
          {visible ? <IconEyeOff /> : <IconEye />}
        </button>
      </div>

      <div className="strength-meter" data-score={assessment.score} id={`${fieldId}-strength`} hidden={!value}>
        <div className="strength-bars" aria-hidden="true">
          {[1, 2, 3, 4].map((step) => (
            <span key={step} data-filled={assessment.score >= step ? 'true' : 'false'} />
          ))}
        </div>
        <p className="strength-label">
          Strength: <strong>{assessment.label}</strong>
          {assessment.hint ? ` — ${assessment.hint}` : ''}
        </p>
        <ul className="strength-label" style={{ margin: 0, paddingLeft: 'var(--space-4)' }}>
          {assessment.met.map((rule) => (
            <li key={rule.id} style={{ color: rule.ok ? 'var(--color-success)' : 'var(--color-ink-faint)' }}>
              {rule.label}
            </li>
          ))}
        </ul>
      </div>
    </Field>
  );
}
