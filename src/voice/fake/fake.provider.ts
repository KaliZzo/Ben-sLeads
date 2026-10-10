import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseCallOutcome, type CallOutcome } from '../../agent/call-outcome';
import type { Env } from '../../config/env';
import type { CallDisposition, CallEvent, StartCallRequest, StartedCall, ToolResult, VoiceProvider } from '../voice-provider';
import { hasWebhookSecret, WEBHOOK_SECRET_HEADER } from '../webhook-secret';

const fakeWebhookSchema = z.object({
  fake: z.literal(true),
  callId: z.string(),
  providerCallId: z.string(),
  disposition: z.enum(['answered', 'no-answer', 'busy', 'voicemail', 'failed']),
  outcome: z.unknown().optional(),
});

/** The agent calling one of our tools mid-call. */
const fakeToolCallSchema = z.object({
  fake: z.literal(true),
  tool: z.literal(true),
  callId: z.string(),
  providerCallId: z.string(),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.unknown() })),
});

/** Weighted list of what a simulated call can turn into. */
const SCENARIOS: { weight: number; disposition: CallDisposition; outcome?: (req: StartCallRequest) => CallOutcome }[] = [
  { weight: 35, disposition: 'no-answer' },
  { weight: 10, disposition: 'voicemail' },
  { weight: 5, disposition: 'busy' },
  {
    weight: 25,
    disposition: 'answered',
    outcome: (req) => ({
      result: 'BOOKED',
      meetingAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      customerName: req.leadName ?? 'Simulated Customer',
      address: '1 Simulated Way, Springfield',
      zipCode: '62701',
      notes: 'Simulated call',
    }),
  },
  {
    weight: 20,
    disposition: 'answered',
    outcome: () => ({ result: 'NOT_INTERESTED', notInterestedReason: 'Simulated: already has a provider' }),
  },
  { weight: 5, disposition: 'answered', outcome: () => ({ result: 'CALLBACK' }) },
  {
    weight: 5,
    disposition: 'answered',
    outcome: () => ({ result: 'NEEDS_HUMAN', followUpReason: 'Simulated: wants to talk to a person about repair work' }),
  },
];

/**
 * Simulates calls without any paid service: after a few seconds it posts a random
 * end-of-call webhook to our own endpoint, exercising the same path real calls use.
 */
export class FakeVoiceProvider implements VoiceProvider {
  readonly name = 'fake';
  private readonly logger = new Logger(FakeVoiceProvider.name);

  constructor(private readonly env: Env) {}

  async startCall(request: StartCallRequest): Promise<StartedCall> {
    const providerCallId = `fake-${randomUUID()}`;
    const scenario = pickScenario();
    const durationMs = 2_000 + Math.random() * 6_000;

    setTimeout(() => {
      this.postWebhook({
        fake: true,
        callId: request.callId,
        providerCallId,
        disposition: scenario.disposition,
        outcome: scenario.outcome?.(request),
      }).catch((error) => this.logger.error(`Fake webhook failed: ${error}`));
    }, durationMs);

    return { providerCallId };
  }

  isAuthentic(headers: Record<string, string | string[] | undefined>): boolean {
    return hasWebhookSecret(headers, this.env.WEBHOOK_SECRET);
  }

  parseWebhook(body: unknown): CallEvent | null {
    const toolCall = fakeToolCallSchema.safeParse(body);
    if (toolCall.success) {
      const { callId, providerCallId, toolCalls } = toolCall.data;
      return { type: 'tool-calls', callId, providerCallId, toolCalls };
    }

    const parsed = fakeWebhookSchema.safeParse(body);
    if (!parsed.success) return null;
    const { callId, providerCallId, disposition, outcome } = parsed.data;
    return {
      type: 'ended',
      callId,
      providerCallId,
      disposition,
      endedReason: `fake-${disposition}`,
      outcome: outcome === undefined ? null : parseCallOutcome(outcome),
      rawOutcome: outcome ?? null,
      summary: null,
      transcript: null,
      recordingUrl: null,
    };
  }

  toolResponse(results: ToolResult[]): unknown {
    return { results };
  }

  private async postWebhook(body: z.infer<typeof fakeWebhookSchema>): Promise<void> {
    const response = await fetch(`${this.env.PUBLIC_BASE_URL}/webhooks/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WEBHOOK_SECRET_HEADER]: this.env.WEBHOOK_SECRET },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }
}

function pickScenario() {
  const total = SCENARIOS.reduce((sum, s) => sum + s.weight, 0);
  let roll = Math.random() * total;
  for (const scenario of SCENARIOS) {
    roll -= scenario.weight;
    if (roll < 0) return scenario;
  }
  return SCENARIOS[0];
}
