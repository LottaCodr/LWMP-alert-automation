import { useCallback, useEffect, useRef } from 'react';
import type { JSX, ReactNode } from 'react';
import { IconClose } from './Icons.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}

/**
 * Accessible dialog: labelled by its title, `aria-modal`, Escape to close,
 * focus moved into the dialog on open and returned to the trigger on close,
 * and Tab cycling contained inside (WCAG 2.1.2 no keyboard trap, 2.4.3 focus order).
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  footer,
  wide = false,
  children,
}: ModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);
  const titleId = 'modal-title';
  const descriptionId = 'modal-description';

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement;
    const dialog = dialogRef.current;

    const focusTarget = dialog?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button');
    focusTarget?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div
        ref={dialogRef}
        className={`modal ${wide ? 'modal-wide' : ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <div className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button type="button" className="icon-button" onClick={close} aria-label="Close dialog">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-actions">{footer}</div> : null}
      </div>
    </div>
  );
}
