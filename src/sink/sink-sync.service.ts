import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LEAD_SINK, type LeadSink, type LeadView } from './lead-sink';

/** Google Sheets allows 60 writes per minute per user; 10 leads every 15s stays under it. */
const BATCH_SIZE = 10;

/**
 * Pushes lead changes to the sink. The database is the source of truth; the sink
 * catches up, so a sink outage delays results but never loses them.
 */
@Injectable()
export class SinkSyncService {
  private readonly logger = new Logger(SinkSyncService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEAD_SINK) private readonly sink: LeadSink,
  ) {}

  @Interval(15_000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.syncPending();
    } finally {
      this.running = false;
    }
  }

  async syncPending(): Promise<number> {
    const leads = await this.prisma.lead.findMany({
      where: { revision: { gt: this.prisma.lead.fields.sinkRevision } },
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE,
      include: { calls: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });

    let synced = 0;
    for (const lead of leads) {
      const lastCall = lead.calls[0];
      const view: LeadView = {
        id: lead.id,
        status: lead.status,
        meetingAt: lead.meetingAt,
        timezone: lead.timezone,
        name: lead.customerName ?? lead.name,
        phone: lead.phone,
        altPhone: lead.altPhone,
        address: lead.address,
        zipCode: lead.zipCode,
        notes: lead.notes,
        notInterestedReason: lead.notInterestedReason,
        attempts: lead.attempts,
        lastCallAt: lead.lastCallAt,
        callSummary: lastCall?.summary ?? null,
        recordingUrl: lastCall?.recordingUrl ?? null,
        followUpReason: lead.followUpReason,
        callbackAt: lead.callbackAt,
      };

      try {
        const ref = await this.sink.upsert(view, lead.sinkRef);
        // Record the revision we sent, not the latest: a change made meanwhile syncs on the next tick.
        await this.prisma.lead.update({ where: { id: lead.id }, data: { sinkRef: ref, sinkRevision: lead.revision } });
        synced++;
      } catch (error) {
        this.logger.error(`Sink ${this.sink.name} failed for lead ${lead.id}, will retry: ${error}`);
        break; // likely an outage or rate limit; back off until the next tick
      }
    }
    return synced;
  }
}
