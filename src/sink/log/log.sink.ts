import { Logger } from '@nestjs/common';
import type { LeadSink, LeadView } from '../lead-sink';

/** Writes results to the console. For local development without Google credentials. */
export class LogSink implements LeadSink {
  readonly name = 'log';
  private readonly logger = new Logger(LogSink.name);

  async upsert(lead: LeadView, ref: string | null): Promise<string> {
    const meeting = lead.meetingAt ? ` meeting=${lead.meetingAt.toISOString()}` : '';
    const reason = lead.notInterestedReason ? ` reason="${lead.notInterestedReason}"` : '';
    this.logger.log(`${ref ? 'update' : 'insert'} ${lead.phone} ${lead.status}${meeting}${reason}`);
    return lead.id;
  }
}
