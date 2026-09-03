import { parse as parseCsv } from 'csv-parse/sync';
import { ApiError } from '../errors.js';
import { audit, lookupHash } from '../database-pg.js';
import { assessImportRows, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, MIN_IMPORT_TEXT_LENGTH } from '../domain/csv-import.js';
import { createMember, parseMemberPayload } from './members.js';
import type { ImportRowDto, MemberRow, SafeUser } from '../types.js';
import { db } from '../database-pg.js';

type CsvRecord = Record<string, unknown>;

export interface ImportPreview {
  rows: ImportRowDto[];
  summary: { total: number; ready: number; invalid: number; duplicates: number };
}

export interface ImportRejection {
  rowNumber: number | undefined;
  reason: string;
}

export interface ImportCommitResult {
  imported: number;
  rejected: ImportRejection[];
  message: string;
}

/** Validate and annotate every row without writing anything to the database. */
export async function previewImport(csvText: unknown): Promise<ImportPreview> {
  if (typeof csvText !== 'string' || csvText.length < MIN_IMPORT_TEXT_LENGTH || csvText.length > MAX_IMPORT_BYTES) {
    throw ApiError.unprocessable('Upload a CSV text file smaller than 450 KB.', 'INVALID_IMPORT');
  }

  let records: CsvRecord[];
  try {
    records = parseCsv(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: false,
      trim: true,
      bom: true,
    });
  } catch {
    throw ApiError.unprocessable(
      'The CSV could not be read. Include a header row and consistent columns.',
      'INVALID_IMPORT',
    );
  }

  if (!records.length || records.length > MAX_IMPORT_ROWS) {
    throw ApiError.unprocessable(`Import between 1 and ${MAX_IMPORT_ROWS} rows at a time.`, 'INVALID_IMPORT');
  }

  const phoneHashIndex = await loadPhoneHashIndex();
  return assessImportRows(records, (normalizedPhone) => phoneHashIndex.get(lookupHash(normalizedPhone)) ?? null);
}

async function loadPhoneHashIndex(): Promise<Map<string, { memberCode: string; fullName: string }>> {
  const rows = await db.all<Pick<MemberRow, 'phone_hash' | 'member_code' | 'first_name' | 'last_name'>>(
    'SELECT phone_hash, member_code, first_name, last_name FROM members WHERE phone_hash IS NOT NULL',
  );
  const index = new Map<string, { memberCode: string; fullName: string }>();
  for (const row of rows) {
    if (!row.phone_hash) continue;
    index.set(row.phone_hash, { memberCode: row.member_code, fullName: `${row.first_name} ${row.last_name}` });
  }
  return index;
}

/** Commit only the rows an operator explicitly approved in the preview. */
export async function commitImport(rows: unknown, user: SafeUser): Promise<ImportCommitResult> {
  const candidates = Array.isArray(rows) ? (rows as ImportRowDto[]) : [];
  if (!candidates.length || candidates.length > MAX_IMPORT_ROWS) {
    throw ApiError.unprocessable(
      `Select between 1 and ${MAX_IMPORT_ROWS} validated rows to import.`,
      'INVALID_IMPORT_COMMIT',
    );
  }

  let imported = 0;
  const rejected: ImportRejection[] = [];

  for (const item of candidates) {
    if (!item?.valid || item?.duplicate) {
      rejected.push({ rowNumber: item?.rowNumber, reason: 'Row is invalid or a duplicate candidate.' });
      continue;
    }
    try {
      await createMember(
        parseMemberPayload(
          { ...item, consentRecorded: true, confirmPotentialDuplicate: false },
          { requireConsent: true },
        ),
        user,
        { source: 'Reviewed CSV import' },
      );
      imported += 1;
    } catch (error) {
      rejected.push({
        rowNumber: item?.rowNumber,
        reason: error instanceof Error ? error.message : 'Row could not be saved.',
      });
    }
  }

  await audit({
    actorId: user.id,
    actorName: user.fullName,
    action: 'members_imported',
    entityType: 'import',
    summary: `Committed reviewed CSV import: ${imported} member(s) created, ${rejected.length} skipped.`,
    metadata: { imported, rejected: rejected.length },
  });

  return {
    imported,
    rejected,
    message: `${imported} member record(s) imported. No raw CSV was retained by the server.`,
  };
}
