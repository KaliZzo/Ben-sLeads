import { Logger } from '@nestjs/common';
import { google, type sheets_v4 } from 'googleapis';
import type { Env } from '../../config/env';
import type { LeadSink, LeadView } from '../lead-sink';

const HEADER = [
  'Status',
  'Meeting Time',
  'Name',
  'Phone',
  'Phone 2',
  'Address',
  'ZIP Code',
  'Notes',
  'Not-Interested Reason',
  'Attempts',
  'Last Call',
  'Call Summary',
  'Recording',
  'Lead ID',
  // Added later, so existing rows keep their columns.
  'Follow-Up Needed',
  'Call Back At',
];
const LAST_COLUMN = String.fromCharCode('A'.charCodeAt(0) + HEADER.length - 1);
const LEAD_ID_COLUMN = HEADER.indexOf('Lead ID');
/** Wide enough to see notes typed to the right of our columns, so a new row never lands on them. */
const SCAN_LAST_COLUMN = 'Z';

/**
 * The 1-based row for a lead: the row already holding its Lead ID, or the first row after
 * everything in the sheet. `rows` is the sheet from row 1, header included.
 */
export function rowFor(rows: unknown[][], leadId: string): number {
  const index = rows.findIndex((row, i) => i > 0 && row[LEAD_ID_COLUMN] === leadId);
  return index >= 0 ? index + 1 : Math.max(rows.length, 1) + 1;
}

/** One row per lead in a single tab. The row number is the ref we keep in the database. */
export class GoogleSheetsSink implements LeadSink {
  readonly name = 'google-sheets';
  private readonly logger = new Logger(GoogleSheetsSink.name);
  private readonly sheets: sheets_v4.Sheets;
  private readonly spreadsheetId: string;
  private readonly tab: string;
  private headerChecked = false;

  constructor(env: Env) {
    const auth = new google.auth.GoogleAuth({
      keyFile: env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });
    this.spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID!;
    this.tab = env.GOOGLE_SHEETS_TAB;
  }

  /**
   * Writes the lead to its own row, always starting at column A. The row is found by Lead ID,
   * so sorting the sheet or typing notes in it never sends an update to the wrong row.
   * Not `values.append`: it continues "the table" it detects, which shifts columns as soon as
   * a row starts somewhere other than column A.
   */
  async upsert(lead: LeadView): Promise<string> {
    await this.ensureHeader();
    const current = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A:${SCAN_LAST_COLUMN}`,
    });
    const row = String(rowFor(current.data.values ?? [], lead.id));
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A${row}:${LAST_COLUMN}${row}`,
      // RAW, not USER_ENTERED: text the customer said must never be evaluated as a formula.
      valueInputOption: 'RAW',
      requestBody: { values: [toRow(lead)] },
    });
    return row;
  }

  private async ensureHeader(): Promise<void> {
    if (this.headerChecked) return;
    const range = `${this.tab}!A1:${LAST_COLUMN}1`;
    const current = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range });
    // Rewritten when the columns changed, so an older sheet gets the current header.
    if (current.data.values?.[0]?.join('\t') !== HEADER.join('\t')) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADER] },
      });
      this.logger.log(`Wrote header row to "${this.tab}"`);
    }
    this.headerChecked = true;
  }
}

function toRow(lead: LeadView): string[] {
  return [
    lead.status,
    formatInZone(lead.meetingAt, lead.timezone),
    lead.name ?? '',
    lead.phone,
    lead.altPhone ?? '',
    lead.address ?? '',
    lead.zipCode ?? '',
    lead.notes ?? '',
    lead.notInterestedReason ?? '',
    String(lead.attempts),
    formatInZone(lead.lastCallAt, lead.timezone),
    lead.callSummary ?? '',
    lead.recordingUrl ?? '',
    lead.id,
    lead.followUpReason ?? '',
    formatInZone(lead.callbackAt, lead.timezone),
  ];
}

/** e.g. "Wed, Oct 7, 2026, 10:30 AM EDT" in the lead's own timezone. */
export function formatInZone(date: Date | null, timeZone: string): string {
  if (!date) return '';
  return date.toLocaleString('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
