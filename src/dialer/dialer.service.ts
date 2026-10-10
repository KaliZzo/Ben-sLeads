import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CallsService } from '../calls/calls.service';
import { ENV, type Env } from '../config/env';
import { CallStatus, LeadStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { VOICE_PROVIDER, type VoiceProvider } from '../voice/voice-provider';

/** A call that has not ended after this long is assumed lost (Vapi's max call length is 10 minutes). */
const STALE_CALL_MS = 20 * 60_000;

interface ClaimedLead {
  id: string;
  /** The number to dial this time: the first phone, or the second after no answer. */
  phone: string;
  name: string | null;
  timezone: string;
  importNotes: string | null;
}

/**
 * Keeps up to MAX_CONCURRENT_CALLS calls running. Every few seconds it fills the free
 * slots with leads that are due, within calling hours. Postgres is the queue.
 *
 * Run a single instance of the app: two instances would each fill the free slots.
 */
@Injectable()
export class DialerService {
  private readonly logger = new Logger(DialerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly calls: CallsService,
    @Inject(VOICE_PROVIDER) private readonly provider: VoiceProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Interval(5_000)
  async tick(): Promise<void> {
    if (!this.env.DIALER_ENABLED || this.running) return;
    this.running = true;
    try {
      await this.failStaleCalls();
      await this.dialDueLeads();
    } catch (error) {
      this.logger.error(`Dialer tick failed: ${error}`);
    } finally {
      this.running = false;
    }
  }

  async dialDueLeads(): Promise<number> {
    const active = await this.prisma.lead.count({ where: { status: LeadStatus.CALLING } });
    const freeSlots = this.env.MAX_CONCURRENT_CALLS - active;
    if (freeSlots <= 0) return 0;

    const claimed = await this.claimDueLeads(freeSlots);
    await Promise.all(claimed.map((call) => this.startCall(call.callId, call.lead)));
    return claimed.length;
  }

  /**
   * Atomically moves due leads to CALLING and creates their Call rows.
   * SKIP LOCKED means two concurrent claims never pick the same lead.
   */
  private claimDueLeads(limit: number) {
    const { CALLING_HOURS_START: start, CALLING_HOURS_END: end } = this.env;

    return this.prisma.$transaction(async (tx) => {
      // A CTE, not `WHERE id IN (subquery)`: Postgres may re-run such a subquery and claim more than LIMIT rows.
      const leads = await tx.$queryRaw<ClaimedLead[]>`
        WITH due AS (
          SELECT id FROM "Lead"
          WHERE status = 'PENDING'
            AND consent
            AND "nextAttemptAt" <= now()
            AND extract(hour FROM now() AT TIME ZONE timezone) >= ${start}
            AND extract(hour FROM now() AT TIME ZONE timezone) < ${end}
          -- A second phone goes first, so it rings right after the first one misses.
          ORDER BY "dialAltPhone" DESC, "nextAttemptAt"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "Lead" AS lead
        SET status = 'CALLING',
            -- The second phone belongs to the same attempt as the first.
            attempts = lead.attempts + (CASE WHEN lead."dialAltPhone" THEN 0 ELSE 1 END),
            "lastCallAt" = now(),
            "updatedAt" = now()
        FROM due
        WHERE lead.id = due.id
        RETURNING lead.id,
                  CASE WHEN lead."dialAltPhone" AND lead."altPhone" IS NOT NULL THEN lead."altPhone" ELSE lead.phone END AS phone,
                  lead.name, lead.timezone, lead."importNotes"`;

      return Promise.all(
        leads.map(async (lead) => {
          const call = await tx.call.create({
            data: { leadId: lead.id, provider: this.provider.name, phone: lead.phone },
            select: { id: true },
          });
          return { callId: call.id, lead };
        }),
      );
    });
  }

  private async startCall(callId: string, lead: ClaimedLead): Promise<void> {
    try {
      const { providerCallId, agentVersion } = await this.provider.startCall({
        callId,
        phone: lead.phone,
        leadName: lead.name,
        timezone: lead.timezone,
        importNotes: lead.importNotes,
        previousCalls: await this.previousCalls(lead.id),
      });
      await this.prisma.call.update({ where: { id: callId }, data: { providerCallId, agentVersion } });
    } catch (error) {
      this.logger.error(`Could not start call ${callId} to lead ${lead.id}: ${error}`);
      await this.calls.endCall(callId, {
        status: CallStatus.FAILED,
        disposition: 'failed',
        endedReason: `start-failed: ${String(error).slice(0, 200)}`,
        outcome: null,
      });
    }
  }

  /** What earlier answered calls with this lead were about, so the agent picks up where they left off. */
  private async previousCalls(leadId: string) {
    const calls = await this.prisma.call.findMany({
      where: { leadId, summary: { not: null } },
      orderBy: { startedAt: 'desc' },
      take: 3,
      select: { startedAt: true, summary: true },
    });
    return calls.map((call) => ({ at: call.startedAt, summary: call.summary! }));
  }

  /** Frees the slot of any call whose end-of-call webhook never arrived, and schedules a retry. */
  async failStaleCalls(): Promise<void> {
    const stale = await this.prisma.call.findMany({
      where: {
        status: { in: [CallStatus.QUEUED, CallStatus.IN_PROGRESS] },
        startedAt: { lt: new Date(Date.now() - STALE_CALL_MS) },
      },
      select: { id: true },
    });

    for (const call of stale) {
      this.logger.warn(`Call ${call.id} never reported an end; marking it failed`);
      await this.calls.endCall(call.id, { status: CallStatus.FAILED, disposition: 'failed', endedReason: 'stale', outcome: null });
    }
  }
}
