import { Inject, Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { ENV, type Env } from '../config/env';
import { LeadStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export interface ImportReport {
  imported: number;
  duplicates: number;
  rejected: { line: number; reason: string }[];
}

const CONSENT_YES = new Set(['true', 'yes', 'y', '1']);

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Imports leads from CSV with columns: phone, phone2 (optional), name, timezone (optional), consent, notes (optional).
   * phone2 is dialed when a call to phone is not answered.
   * Rows without consent or with an invalid phone are rejected; phones already in the database are skipped.
   */
  async importCsv(csv: string): Promise<ImportReport> {
    const rows: Record<string, string>[] = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    const report: ImportReport = { imported: 0, duplicates: 0, rejected: [] };
    const leads = new Map<string, { phone: string; altPhone: string | null; name: string | null; timezone: string; consent: boolean; importNotes: string | null }>();

    rows.forEach((row, index) => {
      const line = index + 2; // header is line 1
      const phone = parsePhoneNumberFromString(row.phone ?? '', 'US');
      const timezone = row.timezone || this.env.DEFAULT_TIMEZONE;

      const altPhone = row.phone2 ? parsePhoneNumberFromString(row.phone2, 'US') : undefined;

      if (!phone?.isValid()) return report.rejected.push({ line, reason: `invalid phone "${row.phone}"` });
      if (altPhone && !altPhone.isValid()) return report.rejected.push({ line, reason: `invalid phone2 "${row.phone2}"` });
      if (!CONSENT_YES.has((row.consent ?? '').toLowerCase())) return report.rejected.push({ line, reason: 'no consent' });
      if (!isValidTimeZone(timezone)) return report.rejected.push({ line, reason: `unknown timezone "${timezone}"` });
      if (leads.has(phone.number)) return report.duplicates++;

      leads.set(phone.number, {
        phone: phone.number,
        altPhone: altPhone && altPhone.number !== phone.number ? altPhone.number : null,
        name: row.name || null,
        timezone,
        consent: true,
        importNotes: row.notes || null,
      });
    });

    const { count } = await this.prisma.lead.createMany({ data: [...leads.values()], skipDuplicates: true });
    report.imported = count;
    report.duplicates += leads.size - count;
    return report;
  }

  async countByStatus(): Promise<Record<LeadStatus, number>> {
    const groups = await this.prisma.lead.groupBy({ by: ['status'], _count: true });
    const counts = Object.fromEntries(Object.values(LeadStatus).map((status) => [status, 0])) as Record<LeadStatus, number>;
    for (const group of groups) counts[group.status] = group._count;
    return counts;
  }

  list(status?: LeadStatus) {
    return this.prisma.lead.findMany({
      where: status ? { status } : undefined,
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
