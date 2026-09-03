import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { ApiError, imports } from '../../api/index.js';
import type { ImportCommitResult, ImportPreviewDto, ImportRowDto } from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { navigate } from '../../app/router.js';
import { Badge, Button, Card, EmptyState, ErrorPanel } from '../../components/ui.js';
import { useToasts } from '../../components/Toasts.js';
import { IconAlert, IconCheck, IconDownload, IconFile, IconUpload } from '../../components/Icons.js';
import { formatBirthday, pluralise } from '../../lib/format.js';

const TEMPLATE = `firstName,lastName,preferredName,phone,birthMonth,birthDay,birthYear,ministryGroup,status,birthdayAlertAllowed
Adaeze,Okonkwo,Ada,08031234567,3,14,1988,Women's Fellowship,active,true
Tunde,Bakare,,+2348031234568,11,2,,Men's Fellowship,active,true`;

const MAX_BYTES = 450 * 1024;

/**
 * Reviewed CSV import.
 *
 * Three explicit stages — upload, review, commit — because the preview is the
 * safety net: invalid rows and duplicate phone candidates are named, nothing is
 * written until the operator confirms, and the raw CSV is never retained.
 */
export function ImportsPage(): JSX.Element {
  const session = useSession();
  const toasts = useToasts();
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportCommitResult | null>(null);

  const upload = useCallback(async (file: File) => {
    setError(null);
    setResult(null);
    if (file.size > MAX_BYTES) {
      setError('That file is larger than 450 KB. Split it into smaller batches.');
      return;
    }
    setBusy(true);
    try {
      const csvText = await file.text();
      const response = await imports.preview(csvText);
      setPreview(response);
      setFileName(file.name);
      setSelected(new Set(response.rows.filter((row) => row.valid && !row.duplicate).map((row) => row.rowNumber)));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The file could not be read.');
    } finally {
      setBusy(false);
    }
  }, []);

  const onFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void upload(file);
      event.target.value = '';
    },
    [upload],
  );

  const toggleRow = useCallback((rowNumber: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }, []);

  const commit = useCallback(async () => {
    if (!preview) return;
    const rows = preview.rows.filter((row) => selected.has(row.rowNumber));
    if (!rows.length) {
      setError('Select at least one validated row to import.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await imports.commit(rows);
      setResult(response);
      setPreview(null);
      setSelected(new Set());
      toasts.success(response.message);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The import could not be committed.');
    } finally {
      setBusy(false);
    }
  }, [preview, selected, toasts]);

  const selectable = useMemo(() => (preview?.rows ?? []).filter((row) => row.valid && !row.duplicate), [preview]);
  const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(row.rowNumber));

  const downloadTemplate = useCallback(() => {
    const blob = new Blob([`${TEMPLATE}\n`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'living-water-members-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  if (!session.capabilities.canImportMembers) {
    return (
      <ErrorPanel
        title="Not available for your role"
        message="Only organisation owners and membership officers can import member records."
      />
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">Bulk data</span>
          <h1>Import members from CSV</h1>
          <p>
            Upload an export from your membership system. Every row is validated and duplicate phone numbers are flagged
            before anything is written. The file itself is never stored on the server.
          </p>
        </div>
        <div className="header-actions">
          <Button icon={<IconDownload />} onClick={downloadTemplate}>
            Download template
          </Button>
        </div>
      </header>

      {error ? (
        <div className="form-alert" role="alert">
          <IconAlert />
          <span>{error}</span>
        </div>
      ) : null}

      {result ? (
        <Card title="Import complete" eyebrow={`${pluralise(result.imported, 'record')} created`} padded>
          <div className="stack">
            <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
              {result.message}
            </p>
            {result.rejected.length ? (
              <div className="stack-sm">
                <h3>Skipped rows</h3>
                <ul style={{ paddingLeft: 'var(--space-5)', fontSize: 'var(--text-sm)' }}>
                  {result.rejected.map((rejection, index) => (
                    <li key={`${rejection.rowNumber ?? 'unknown'}-${index}`}>
                      {rejection.rowNumber ? `Row ${rejection.rowNumber}: ` : ''}
                      {rejection.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="row">
              <Button variant="primary" onClick={() => navigate('/members')}>
                View the directory
              </Button>
              <Button
                onClick={() => {
                  setResult(null);
                  setFileName('');
                }}
              >
                Import another file
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {!preview && !result ? (
        <Card title="Choose a file" description="CSV with a header row, up to 2,000 rows and 450 KB.">
          <div className="stack">
            <label className="check-row" htmlFor="csv-file">
              <IconFile />
              <span>
                <strong>Expected columns</strong>
                <small>
                  firstName, lastName, preferredName, phone, birthMonth, birthDay, birthYear, ministryGroup, status,
                  birthdayAlertAllowed
                </small>
              </span>
            </label>

            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              disabled={busy}
              className="field-control"
              aria-describedby="csv-hint"
            />
            <p className="field-hint" id="csv-hint">
              {busy
                ? 'Reading and validating your file…'
                : 'Nothing is saved until you review the preview and confirm.'}
            </p>

            <EmptyState
              icon={<IconUpload />}
              title="No file selected"
              description="Pick a CSV export to begin. You will see a row-by-row preview with validation results before anything is imported."
            />
          </div>
        </Card>
      ) : null}

      {preview ? (
        <Card
          title="Review the import"
          eyebrow={fileName}
          description={`${pluralise(preview.summary.total, 'row')} read · ${pluralise(preview.summary.ready, 'row')} ready · ${pluralise(preview.summary.invalid, 'row')} invalid · ${pluralise(preview.summary.duplicates, 'duplicate candidate')}`}
          action={
            <div className="row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((row) => row.rowNumber)))}
              >
                {allSelected ? 'Deselect all' : 'Select all valid'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPreview(null);
                  setSelected(new Set());
                }}
              >
                Start over
              </Button>
            </div>
          }
          padded={false}
        >
          {preview.summary.ready === 0 ? (
            <EmptyState
              icon={<IconAlert />}
              title="No rows are ready to import"
              description="Fix the problems listed below in your spreadsheet and upload it again. Rows with an invalid birthday or phone number cannot be imported."
              action={<Button onClick={() => setPreview(null)}>Choose another file</Button>}
            />
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <caption>
                    Tick the rows you want to import. Invalid and duplicate rows are excluded automatically.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: 48 }}>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={() =>
                            setSelected(allSelected ? new Set() : new Set(selectable.map((row) => row.rowNumber)))
                          }
                          aria-label="Select all valid rows"
                          disabled={!selectable.length}
                        />
                      </th>
                      <th scope="col" style={{ textAlign: 'right' }}>
                        Row
                      </th>
                      <th scope="col">Name</th>
                      <th scope="col">Phone</th>
                      <th scope="col">Birthday</th>
                      <th scope="col">Group</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <ImportRow
                        key={row.rowNumber}
                        row={row}
                        selected={selected.has(row.rowNumber)}
                        onToggle={toggleRow}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="pagination">
                <span>{pluralise(selected.size, 'row')} selected for import</span>
                <Button
                  variant="primary"
                  onClick={() => void commit()}
                  loading={busy}
                  disabled={!selected.size}
                  icon={<IconCheck />}
                >
                  Import selected rows
                </Button>
              </div>
            </>
          )}
        </Card>
      ) : null}
    </>
  );
}

function ImportRow({
  row,
  selected,
  onToggle,
}: {
  row: ImportRowDto;
  selected: boolean;
  onToggle: (rowNumber: number) => void;
}): JSX.Element {
  const blocked = !row.valid || Boolean(row.duplicate);
  return (
    <tr aria-invalid={blocked || undefined}>
      <td>
        <input
          type="checkbox"
          checked={selected && !blocked}
          disabled={blocked}
          onChange={() => onToggle(row.rowNumber)}
          aria-label={`Import row ${row.rowNumber} — ${row.firstName} ${row.lastName}`}
        />
      </td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.rowNumber}</td>
      <td>
        <strong>
          {row.firstName} {row.lastName}
        </strong>
        {row.errors.length ? (
          <small style={{ color: 'var(--color-danger)' }}>{row.errors.join(' · ')}</small>
        ) : row.duplicate ? (
          <small style={{ color: 'var(--color-warning)' }}>
            Possible duplicate of {row.duplicate.fullName} ({row.duplicate.memberCode})
          </small>
        ) : null}
      </td>
      <td>{row.phone ?? '—'}</td>
      <td>{row.birthMonth && row.birthDay ? formatBirthday(row.birthMonth, row.birthDay, row.birthYear) : '—'}</td>
      <td>{row.ministryGroup}</td>
      <td>
        {blocked ? (
          <Badge tone="danger">{row.duplicate ? 'Duplicate' : 'Invalid'}</Badge>
        ) : (
          <Badge tone="success">Ready</Badge>
        )}
      </td>
    </tr>
  );
}
