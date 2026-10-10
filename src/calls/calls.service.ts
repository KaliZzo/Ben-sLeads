import { Inject, Injectable, Logger } from '@nestjs/common';
import { AgentToolsService } from '../agent/agent-tools';
import type { CallOutcome } from '../agent/call-outcome';
import { ENV, type Env } from '../config/env';
import { CallStatus, LeadStatus } from '../generated/prisma/enums';
import type { Prisma } from '../generated/prisma/client';
import { nextLeadState } from '../leads/lead-transitions';
import { PrismaService } from '../prisma/prisma.service';
import type { CallDisposition, CallEvent, ToolResult } from '../voice/voice-provider';

export interface CallEnd {
  status: typeof CallStatus.ENDED | typeof CallStatus.FAILED;
  disposition: CallDisposition;
  endedReason: string;
  outcome: CallOutcome | null;
  rawOutcome?: unknown;
  summary?: string | null;
  transcript?: string | null;
  recordingUrl?: string | null;
  turnLatencyMs?: number | null;
  metrics?: unknown;
}

const LIVE_STATUSES = [CallStatus.QUEUED, CallStatus.IN_PROGRESS];

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: AgentToolsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Returns tool results when the event asked for them; the agent is waiting on the line. */
  async handleEvent(event: CallEvent): Promise<ToolResult[] | void> {
    if (event.type === 'tool-calls') {
      return Promise.all(
        event.toolCalls.map(async (call) => {
          const result = await this.tools.run(call.name, call.arguments);
          this.logger.log(`Call ${event.callId} tool ${call.name}: ${result}`);
          return { id: call.id, name: call.name, result };
        }),
      );
    }

    if (event.type === 'started') {
      await this.prisma.call.updateMany({
        where: { id: event.callId, status: CallStatus.QUEUED },
        data: { status: CallStatus.IN_PROGRESS, providerCallId: event.providerCallId },
      });
      return;
    }

    await this.endCall(event.callId, {
      status: CallStatus.ENDED,
      disposition: event.disposition,
      endedReason: event.endedReason,
      outcome: event.outcome,
      rawOutcome: event.rawOutcome,
      summary: event.summary,
      transcript: event.transcript,
      recordingUrl: event.recordingUrl,
      turnLatencyMs: event.turnLatencyMs,
      metrics: event.metrics,
    });
  }

  /**
   * Records how a call ended and moves its lead to the next state, in one transaction.
   * Safe to call more than once for the same call: only the first call has any effect.
   */
  async endCall(callId: string, end: CallEnd): Promise<void> {
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.call.updateMany({
        where: { id: callId, status: { in: LIVE_STATUSES } },
        data: {
          status: end.status,
          endedReason: end.endedReason,
          endedAt: now,
          outcome: (end.rawOutcome ?? undefined) as Prisma.InputJsonValue | undefined,
          summary: end.summary ?? null,
          transcript: end.transcript ?? null,
          recordingUrl: end.recordingUrl ?? null,
          turnLatencyMs: end.turnLatencyMs ?? null,
          metrics: (end.metrics ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      if (claimed.count === 0) {
        this.logger.debug(`Ignoring end of call ${callId}: unknown or already ended`);
        return;
      }

      const { lead } = await tx.call.findUniqueOrThrow({ where: { id: callId }, select: { lead: true } });
      if (lead.status !== LeadStatus.CALLING) {
        this.logger.warn(`Lead ${lead.id} is ${lead.status}, expected CALLING; leaving it unchanged`);
        return;
      }

      const update = nextLeadState(
        {
          attempts: lead.attempts,
          disposition: end.disposition,
          outcome: end.outcome,
          now,
          altPhoneUntried: !!lead.altPhone && !lead.dialAltPhone,
          dialedAltPhone: lead.dialAltPhone,
          totalCalls: await tx.call.count({ where: { leadId: lead.id } }),
        },
        { maxAttempts: this.env.MAX_ATTEMPTS, retryDelayMs: this.env.RETRY_DELAY_MINUTES * 60_000 },
      );
      await tx.lead.update({ where: { id: lead.id }, data: { ...update, revision: { increment: 1 } } });
      this.logger.log(`Call ${callId} ended (${end.endedReason}); lead ${lead.id} is now ${update.status}`);
    });
  }
}
