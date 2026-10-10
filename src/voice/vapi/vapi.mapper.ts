import { createHash } from 'node:crypto';
import { z } from 'zod';
import { END_CALL_PHRASE, EXPECTED_TERMS, buildOpeningLine, buildSystemPrompt, buildVoicemailMessage } from '../../agent/agent-script';
import { AGENT_TOOLS } from '../../agent/agent-tools';
import { callOutcomeJsonSchema, parseCallOutcome } from '../../agent/call-outcome';
import type { CallDisposition, CallEvent, StartCallRequest, ToolResult } from '../voice-provider';
import { WEBHOOK_SECRET_HEADER } from '../webhook-secret';

/** Name of the structured output Vapi extracts after each call. */
export const OUTCOME_OUTPUT_NAME = 'call_outcome';

export interface VapiCallOptions {
  phoneNumberId: string;
  agentName: string;
  companyName: string | null;
  llmModel: string;
  voice: { provider: 'vapi' | '11labs' | 'cartesia'; voiceId: string; version: '1' | '2' | 'latest'; model?: string };
  transcriberModel: string;
  /** E.164 number to put customers through to when they ask for a person. */
  transferNumber?: string;
  webhookUrl: string;
  webhookSecret: string;
  now: Date;
}

/** Setting interruptionPhrases replaces Vapi's list, so it is repeated here. */
const VAPI_DEFAULT_INTERRUPTION_PHRASES = [
  'stop', 'shut', 'up', 'enough', 'quiet', 'silence', 'but', 'dont', 'not', 'no',
  'hold', 'wait', 'cut', 'pause', 'nope', 'nah', 'nevermind', 'never', 'bad', 'actually',
];

/** Body for POST https://api.vapi.ai/call with a transient (inline) assistant. */
export function buildCreateCallBody(request: StartCallRequest, options: VapiCallOptions) {
  const systemPrompt = buildSystemPrompt({
    agentName: options.agentName,
    companyName: options.companyName,
    leadName: request.leadName,
    timezone: request.timezone,
    now: options.now,
    importNotes: request.importNotes,
    previousCalls: request.previousCalls,
    canTransfer: !!options.transferNumber,
  });

  const assistant = {
    name: 'outbound-lead-agent',
    // Waits for their hello, then plays the fixed opener with no model step: about 0.7s after
    // their hello instead of 1.3 to 1.9s, the silence people hung up in. The cost: a pickup
    // that never speaks gets nothing (4 of 125 calls; on retry they stayed silent, so most
    // are machines). Speaking first also collided with "Hello?" and stuttered.
    firstMessageMode: 'assistant-waits-for-user',
    firstMessage: buildOpeningLine({ agentName: options.agentName }),
    // Let them cut in with "who's this?" like they would with a person.
    firstMessageInterruptionsEnabled: true,
    model: {
      provider: 'openai',
      model: options.llmModel,
      // Terra is a reasoning model and defaults to medium effort. A phone turn has no time to think.
      reasoningEffort: 'none',
      // The model was the slowest part of every turn (about 0.8s). Fast processing costs 2x tokens,
      // which is about a cent per call.
      serviceTier: 'fast',
      // Replies are up to three sentences; a cap keeps a runaway answer from talking for half a minute.
      maxTokens: 250,
      // A little variety keeps the agent from saying the same sentence the same way every time.
      temperature: 0.6,
      messages: [{ role: 'system', content: systemPrompt }],
      tools: buildTools(options.transferNumber),
    },
    // Hangs up when the agent says its closing line, even if it forgets to call endCall. Without
    // the final "!" so "Goodbye." matches too: one call stayed open after the agent's goodbye.
    endCallPhrases: [END_CALL_PHRASE.replace(/[.!]+$/, '')],
    voice: buildVoice(options.voice),
    transcriber: {
      provider: 'deepgram',
      model: options.transcriberModel,
      language: 'en',
      // Without these the transcriber heard "AI" as "HeyEye" and garbled street names.
      keyterm: EXPECTED_TERMS,
      // A turn ends at most 3s after speech, whatever Flux's confidence (default 5s). After a
      // call screener's hold the person's "Hello? Who's calling?" sat in one open turn with the
      // screener's words, and the agent answered 16 seconds later; the person said no.
      ...(options.transcriberModel.startsWith('flux') ? { eotTimeoutMs: 3000 } : {}),
    },
    // Measured before: replies started 1.5s (median) to 2.9s (p90) after the customer stopped.
    startSpeakingPlan: {
      waitSeconds: 0.2,
      // Flux decides the end of a turn itself; other models need Vapi's endpointing model.
      ...(options.transcriberModel.startsWith('flux') ? {} : { smartEndpointingPlan: { provider: 'livekit' } }),
    },
    // Two words before the agent yields, so "yeah" or a cough doesn't cut it off mid-sentence.
    // "stop", "wait", "no" and the like still interrupt immediately.
    stopSpeakingPlan: {
      numWords: 2,
      voiceSeconds: 0.2,
      backoffSeconds: 1,
      // Vapi's defaults, plus greetings: people say "hello?" right as the opener starts, and
      // an agent that talks over it gets hung up on.
      interruptionPhrases: [...VAPI_DEFAULT_INTERRUPTION_PHRASES, 'hello', 'hi', 'hey', 'who'],
    },
    // Quiet office ambience: a dead-silent line sounds like a machine.
    backgroundSound: 'office',
    hooks: [
      // Nudge once when the line goes quiet, instead of sitting in silence until the call times out.
      // Longer than a call screener's hold (about 23 seconds): at 10 the agent asked "can you hear
      // me?" into the hold, right before the person might come on.
      {
        on: 'customer.speech.timeout',
        options: { timeoutSeconds: 25, triggerMaxCount: 1 },
        do: [{ type: 'say', exact: ['Hello? Are you still there?', 'Hi, can you hear me okay?'] }],
      },
    ],
    maxDurationSeconds: 600,
    // Detection is off by default. On detection Vapi waits for the beep and leaves this message.
    // Audio-based (Vapi's default): the transcript-based check only fired after the agent's
    // opener had already played into short greetings like "Hi, it's Laurie", so the recording
    // got half an opener before the message. Audio detection did not mistake call screeners
    // for voicemail in earlier calls.
    voicemailDetection: { provider: 'vapi', type: 'audio' },
    voicemailMessage: buildVoicemailMessage({ agentName: options.agentName }),
    serverMessages: ['status-update', 'end-of-call-report', 'tool-calls'],
    // Inline server URLs do not get org credentials, so the secret travels as a header.
    server: { url: options.webhookUrl, headers: { [WEBHOOK_SECRET_HEADER]: options.webhookSecret } },
    // Echoed back in every webhook, so we can find our call without a lookup by provider id.
    metadata: { callId: request.callId },
    artifactPlan: {
      structuredOutputs: [
        {
          name: OUTCOME_OUTPUT_NAME,
          description:
            'Result of an outbound call that tries to book a chimney estimate or service visit. ' +
            `Dates and times are in the customer's timezone (${request.timezone}); write them with that UTC offset.`,
          schema: callOutcomeJsonSchema,
        },
      ],
    },
  };

  return {
    agentVersion: agentVersion(assistant, systemPrompt, request),
    body: {
      phoneNumberId: options.phoneNumberId,
      customer: { number: request.phone, ...(request.leadName ? { name: request.leadName } : {}) },
      assistant,
    },
  };
}

function buildVoice(voice: VapiCallOptions['voice']) {
  if (voice.provider === 'vapi') return { provider: 'vapi', voiceId: voice.voiceId, version: voice.version };
  const model = voice.model ? { model: voice.model } : {};
  // Lower stability lets the voice rise and fall with the words instead of reading them flat.
  if (voice.provider === '11labs') return { provider: '11labs', voiceId: voice.voiceId, ...model, stability: 0.4 };
  return { provider: voice.provider, voiceId: voice.voiceId, ...model };
}

function buildTools(transferNumber: string | undefined) {
  const tools: Record<string, unknown>[] = [
    // Silent: without a message Vapi says a filler like "Goodbye." after the agent's own goodbye.
    { type: 'endCall', messages: [{ type: 'request-start', content: '' }] },
    ...AGENT_TOOLS.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      // Said while the tool runs, so the line never goes quiet.
      messages: [{ type: 'request-start', content: tool.waitingLines[0] }],
    })),
  ];
  if (transferNumber) {
    tools.push({
      type: 'transferCall',
      destinations: [
        {
          type: 'number',
          number: transferNumber,
          description: 'A person on the chimney team. Use when the customer asks for a human or wants something you cannot book.',
          message: 'Sure, connecting you now. One moment.',
          // The teammate hears a short summary before the customer is put through.
          transferPlan: { mode: 'warm-transfer-say-summary' },
        },
      ],
    });
  }
  return tools;
}

/**
 * Same prompt, voice, model and settings give the same fingerprint, so calls can be grouped
 * by version. Per-call facts (name, time, notes, history) are left out.
 */
function agentVersion(assistant: { model: { messages: unknown[] } }, systemPrompt: string, request: StartCallRequest): string {
  const template = systemPrompt.slice(0, systemPrompt.indexOf('# THIS CALL'));
  // The opener is part of the prompt template already; its own copy carries the lead's name.
  const settings = { ...assistant, model: { ...assistant.model, messages: [] }, firstMessage: undefined, metadata: undefined, server: undefined };
  // The opening line inside the template carries the lead's first name; take it out.
  const firstName = request.leadName?.trim().split(/\s+/)[0];
  const normalized = firstName ? template.split(firstName).join('{name}') : template;
  return createHash('sha256').update(normalized).update(JSON.stringify(settings)).digest('hex').slice(0, 12);
}

const ANSWERED = new Set([
  'customer-ended-call',
  'assistant-ended-call',
  'assistant-said-end-call-phrase',
  'assistant-ended-call-after-message-spoken',
  'assistant-ended-call-with-hangup-task',
  'assistant-forwarded-call',
  'silence-timed-out',
  'exceeded-max-duration',
  'call.in-progress.twilio-completed-call',
  'call.in-progress.sip-completed-call',
  'vonage-completed',
]);

/** Vapi has hundreds of endedReason values; anything unrecognised counts as a failure and is retried. */
export function mapEndedReason(endedReason: string): CallDisposition {
  if (ANSWERED.has(endedReason)) return 'answered';
  if (endedReason === 'customer-did-not-answer') return 'no-answer';
  if (endedReason === 'customer-busy') return 'busy';
  if (endedReason === 'voicemail') return 'voicemail';
  return 'failed';
}

const toolCallSchema = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).optional() }),
});

const webhookSchema = z.object({
  message: z.looseObject({
    type: z.string(),
    status: z.string().optional(),
    endedReason: z.string().optional(),
    call: z.looseObject({
      id: z.string(),
      assistant: z.looseObject({ metadata: z.looseObject({ callId: z.string().optional() }).optional() }).optional(),
    }),
    assistant: z.looseObject({ metadata: z.looseObject({ callId: z.string().optional() }).optional() }).optional(),
    analysis: z.looseObject({ summary: z.string().optional() }).optional(),
    artifact: z
      .looseObject({
        transcript: z.string().optional(),
        recordingUrl: z.string().optional(),
        recording: z
          .looseObject({
            stereoUrl: z.string().optional(),
            mono: z.looseObject({ combinedUrl: z.string().optional() }).optional(),
          })
          .optional(),
        structuredOutputs: z.record(z.string(), z.looseObject({ name: z.string().optional(), result: z.unknown() })).optional(),
        performanceMetrics: z.looseObject({ turnLatencyAverage: z.number().optional() }).optional(),
      })
      .optional(),
    toolCallList: z.array(toolCallSchema).optional(),
  }),
});

export function parseVapiWebhook(body: unknown): CallEvent | null {
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) return null;

  const { message } = parsed.data;
  const callId = message.call.assistant?.metadata?.callId ?? message.assistant?.metadata?.callId;
  if (!callId) return null; // not a call we started

  const providerCallId = message.call.id;

  if (message.type === 'status-update' && message.status === 'in-progress') {
    return { type: 'started', callId, providerCallId };
  }

  if (message.type === 'tool-calls') {
    return {
      type: 'tool-calls',
      callId,
      providerCallId,
      toolCalls: (message.toolCallList ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      })),
    };
  }

  if (message.type === 'end-of-call-report') {
    const endedReason = message.endedReason ?? 'unknown';
    const artifact = message.artifact;
    const rawOutcome =
      Object.values(artifact?.structuredOutputs ?? {}).find((output) => output.name === OUTCOME_OUTPUT_NAME)?.result ?? null;

    return {
      type: 'ended',
      callId,
      providerCallId,
      disposition: mapEndedReason(endedReason),
      endedReason,
      outcome: parseCallOutcome(rawOutcome),
      rawOutcome,
      summary: message.analysis?.summary ?? null,
      transcript: artifact?.transcript ?? null,
      recordingUrl: artifact?.recording?.mono?.combinedUrl ?? artifact?.recording?.stereoUrl ?? artifact?.recordingUrl ?? null,
      turnLatencyMs: roundOrNull(artifact?.performanceMetrics?.turnLatencyAverage),
      metrics: artifact?.performanceMetrics ?? null,
    };
  }

  return null;
}

/** Vapi's reply to a tool-calls webhook. */
export function buildToolResponse(results: ToolResult[]) {
  return { results: results.map((r) => ({ toolCallId: r.id, name: r.name, result: r.result })) };
}

/** Vapi sends arguments as an object; OpenAI-style payloads send a JSON string. */
function parseArguments(args: string | Record<string, unknown> | undefined): unknown {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/** Vapi reports 0 for calls that had no turns; that is "no data", not "instant". */
function roundOrNull(value: number | undefined): number | null {
  return value ? Math.round(value) : null;
}
