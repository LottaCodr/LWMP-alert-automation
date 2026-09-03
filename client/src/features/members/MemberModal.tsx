import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { ApiError, members } from '../../api/index.js';
import type { MemberDto, MemberPayload, MemberStatus } from '../../api/types.js';
import { Button, Field, SelectInput, Switch, TextInput } from '../../components/ui.js';
import { Modal } from '../../components/Modal.js';
import { useToasts } from '../../components/Toasts.js';
import { MEMBER_STATUS_OPTIONS } from '../../lib/status.js';
import { MONTH_NAMES } from '../../lib/format.js';

type FieldKey = keyof Pick<
  MemberPayload,
  | 'firstName'
  | 'lastName'
  | 'preferredName'
  | 'phone'
  | 'birthMonth'
  | 'birthDay'
  | 'birthYear'
  | 'status'
  | 'ministryGroup'
>;

interface DuplicateCandidate {
  memberCode: string;
  fullName: string;
}

const EMPTY = {
  firstName: '',
  lastName: '',
  preferredName: '',
  phone: '',
  birthMonth: '1',
  birthDay: '1',
  birthYear: '',
  status: 'active' as MemberStatus,
  ministryGroup: 'General',
  birthdayAlertAllowed: true,
};

function daysInMonth(month: number): number {
  if (month === 2) return 29; // 29 February is accepted and mapped by the parish rule's policy.
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
}

/**
 * Create/edit member dialog.
 *
 * Validation mirrors `memberSchema` on the server so mistakes are caught before
 * a round trip, and the duplicate-phone conflict is surfaced as a decision
 * rather than a flat error — staff can see the existing record and choose.
 */
export function MemberModal({
  open,
  member,
  groups,
  onClose,
  onSaved,
}: {
  open: boolean;
  member: MemberDto | null;
  groups: string[];
  onClose: () => void;
  onSaved: (member: MemberDto, message: string) => void;
}): JSX.Element {
  const toasts = useToasts();
  const editing = Boolean(member);
  const [form, setForm] = useState({ ...EMPTY });
  const [consent, setConsent] = useState(false);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateCandidate | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setFormError(null);
    setDuplicate(null);
    setConfirmDuplicate(false);
    setConsent(false);
    setForm(
      member
        ? {
            firstName: member.firstName,
            lastName: member.lastName,
            preferredName: member.preferredName ?? '',
            phone: member.phone ?? member.phoneMasked ?? '',
            birthMonth: String(member.birthMonth),
            birthDay: String(member.birthDay),
            birthYear: member.birthYear ? String(member.birthYear) : '',
            status: member.status,
            ministryGroup: member.ministryGroup,
            birthdayAlertAllowed: member.birthdayAlertAllowed,
          }
        : { ...EMPTY },
    );
  }, [open, member]);

  const errors = useMemo(() => validate(form, { requireConsent: !editing, consent }), [form, editing, consent]);
  const hasErrors = Object.keys(errors).length > 0;

  const update = useCallback((key: keyof typeof EMPTY, value: string | boolean) => {
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setTouched(true);
      if (hasErrors) return;

      const payload: MemberPayload = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        preferredName: form.preferredName.trim() || null,
        phone: form.phone.trim(),
        birthMonth: Number(form.birthMonth),
        birthDay: Number(form.birthDay),
        birthYear: form.birthYear ? Number(form.birthYear) : null,
        status: form.status,
        ministryGroup: form.ministryGroup.trim(),
        birthdayAlertAllowed: form.birthdayAlertAllowed,
        consentRecorded: true,
        confirmPotentialDuplicate: confirmDuplicate,
      };

      setBusy(true);
      setFormError(null);
      try {
        const result = member ? await members.update(member.id, payload) : await members.create(payload);
        toasts.success(result.message);
        onSaved(result.member, result.message);
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === 'DUPLICATE_CANDIDATE') {
          const existing = (cause.details as { existing?: DuplicateCandidate } | undefined)?.existing;
          setDuplicate(existing ?? null);
          setFormError(cause.message);
        } else if (cause instanceof ApiError && cause.details && Array.isArray(cause.details)) {
          const issues = cause.details as Array<{ path?: string; message?: string }>;
          setFormError(
            issues.map((issue) => `${issue.path ?? 'form'}: ${issue.message ?? ''}`).join(' · ') || cause.message,
          );
        } else {
          setFormError(cause instanceof Error ? cause.message : 'The member could not be saved.');
        }
      } finally {
        setBusy(false);
      }
    },
    [confirmDuplicate, form, hasErrors, member, onSaved, toasts],
  );

  const show = (key: FieldKey): string | null => (touched ? (errors[key] ?? null) : null);

  return (
    <Modal
      open={open}
      title={editing ? `Edit ${member?.fullName ?? 'member'}` : 'Add a member'}
      description={
        editing
          ? 'Changes apply to the next scheduled birthday alert.'
          : 'The phone number is encrypted at rest. Recording the membership basis is required before saving.'
      }
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="member-form" variant="primary" loading={busy}>
            {editing ? 'Save changes' : 'Add member'}
          </Button>
        </>
      }
    >
      <form id="member-form" className="stack" onSubmit={(event) => void submit(event)} noValidate>
        {formError ? (
          <div className="form-alert" role="alert">
            {formError}
          </div>
        ) : null}

        {duplicate ? (
          <div className="form-alert form-alert-info">
            <label className="check-row" style={{ border: 0, background: 'transparent', padding: 0 }}>
              <input
                type="checkbox"
                checked={confirmDuplicate}
                onChange={(event) => setConfirmDuplicate(event.target.checked)}
              />
              <span>
                <strong>
                  Existing record: {duplicate.fullName} ({duplicate.memberCode})
                </strong>
                <small>Tick this box only if you are certain this is a different person.</small>
              </span>
            </label>
          </div>
        ) : null}

        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <Field label="First name" htmlFor="member-first" required error={show('firstName')}>
            <TextInput
              id="member-first"
              value={form.firstName}
              onChange={(event) => update('firstName', event.target.value)}
              invalid={Boolean(show('firstName'))}
              autoFocus
            />
          </Field>
          <Field label="Last name" htmlFor="member-last" required error={show('lastName')}>
            <TextInput
              id="member-last"
              value={form.lastName}
              onChange={(event) => update('lastName', event.target.value)}
              invalid={Boolean(show('lastName'))}
            />
          </Field>
          <Field label="Preferred name" htmlFor="member-preferred" optional>
            <TextInput
              id="member-preferred"
              value={form.preferredName}
              onChange={(event) => update('preferredName', event.target.value)}
            />
          </Field>
          <Field
            label="Mobile number"
            htmlFor="member-phone"
            required
            error={show('phone')}
            hint="Nigerian format: 0803 123 4567 or +234 803 123 4567."
          >
            <TextInput
              id="member-phone"
              type="tel"
              value={form.phone}
              onChange={(event) => update('phone', event.target.value)}
              invalid={Boolean(show('phone'))}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <Field label="Birth month" htmlFor="member-month" required error={show('birthMonth')}>
            <SelectInput
              id="member-month"
              value={form.birthMonth}
              invalid={Boolean(show('birthMonth'))}
              onChange={(event) => update('birthMonth', event.target.value)}
              options={MONTH_NAMES.map((name, index) => ({ value: String(index + 1), label: name }))}
            />
          </Field>
          <Field label="Birth day" htmlFor="member-day" required error={show('birthDay')}>
            <SelectInput
              id="member-day"
              value={form.birthDay}
              onChange={(event) => update('birthDay', event.target.value)}
              invalid={Boolean(show('birthDay'))}
              options={Array.from({ length: daysInMonth(Number(form.birthMonth)) }, (_, index) => ({
                value: String(index + 1),
                label: String(index + 1),
              }))}
            />
          </Field>
          <Field label="Birth year" htmlFor="member-year" optional hint="Used for milestone greetings only.">
            <TextInput
              id="member-year"
              type="number"
              min={1900}
              max={new Date().getFullYear()}
              value={form.birthYear}
              onChange={(event) => update('birthYear', event.target.value)}
              invalid={Boolean(show('birthYear'))}
            />
          </Field>
          <Field label="Status" htmlFor="member-status" required>
            <SelectInput
              id="member-status"
              value={form.status}
              onChange={(event) => update('status', event.target.value)}
              options={MEMBER_STATUS_OPTIONS}
            />
          </Field>
          <Field label="Ministry group" htmlFor="member-group" required error={show('ministryGroup')}>
            <TextInput
              id="member-group"
              value={form.ministryGroup}
              onChange={(event) => update('ministryGroup', event.target.value)}
              list="ministry-groups"
              invalid={Boolean(show('ministryGroup'))}
            />
            <datalist id="ministry-groups">
              {groups.map((group) => (
                <option key={group} value={group} />
              ))}
            </datalist>
          </Field>
        </div>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>
            <strong style={{ fontSize: 'var(--text-sm)' }}>Birthday reminders</strong>
            <br />
            <small className="muted">Switch off to exclude this person from the parish digest.</small>
          </span>
          <Switch
            checked={form.birthdayAlertAllowed}
            onChange={(next) => update('birthdayAlertAllowed', next)}
            label="Include this member in birthday reminders"
          />
        </div>

        {!editing ? (
          <label className="check-row">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>
              <strong>Membership and privacy basis recorded</strong>
              <small>
                This person is a recorded church member and their details may be used for membership care and birthday
                reminders. Required before the record can be saved.
              </small>
            </span>
          </label>
        ) : null}

        {touched && hasErrors ? (
          <p className="field-error" role="alert">
            Please correct the highlighted fields before saving.
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

function validate(
  form: typeof EMPTY,
  { requireConsent, consent }: { requireConsent: boolean; consent: boolean },
): Partial<Record<FieldKey | 'consent', string>> {
  const errors: Partial<Record<FieldKey | 'consent', string>> = {};
  if (form.firstName.trim().length < 2) errors.firstName = 'Enter at least 2 characters.';
  if (form.lastName.trim().length < 2) errors.lastName = 'Enter at least 2 characters.';
  if (form.phone.trim().replace(/\D/g, '').length < 7) errors.phone = 'Enter a mobile number with at least 7 digits.';
  const month = Number(form.birthMonth);
  const day = Number(form.birthDay);
  if (!month || month < 1 || month > 12) errors.birthMonth = 'Choose a month.';
  if (!day || day < 1 || day > daysInMonth(month)) errors.birthDay = 'Choose a valid day for that month.';
  if (form.birthYear) {
    const year = Number(form.birthYear);
    if (year < 1900 || year > new Date().getFullYear()) errors.birthYear = 'Enter a year between 1900 and today.';
  }
  if (form.ministryGroup.trim().length < 2) errors.ministryGroup = 'Enter the ministry group.';
  if (requireConsent && !consent) errors.consent = 'Record the membership basis first.';
  return errors;
}
