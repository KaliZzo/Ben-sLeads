import type { LeadStatus } from '../generated/prisma/enums';

/** Everything an employee needs to see about a lead. */
export interface LeadView {
  id: string;
  status: LeadStatus;
  meetingAt: Date | null;
  timezone: string;
  name: string | null;
  phone: string;
  altPhone: string | null;
  address: string | null;
  zipCode: string | null;
  notes: string | null;
  notInterestedReason: string | null;
  attempts: number;
  lastCallAt: Date | null;
  callSummary: string | null;
  recordingUrl: string | null;
  /** What a person on the team must do; set when the lead is NEEDS_HUMAN or a booking is incomplete. */
  followUpReason: string | null;
  callbackAt: Date | null;
}

/** The seam to wherever results go (Google Sheets, a CRM, ...). One implementation per destination. */
export interface LeadSink {
  readonly name: string;
  /**
   * Creates or updates the lead in the destination.
   * `ref` is what the previous upsert returned for this lead (null the first time);
   * return the ref to use next time, e.g. a sheet row number.
   */
  upsert(lead: LeadView, ref: string | null): Promise<string>;
}

export const LEAD_SINK = Symbol('LEAD_SINK');
