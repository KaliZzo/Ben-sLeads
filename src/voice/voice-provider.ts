import type { PreviousCall } from '../agent/agent-script';
import type { CallOutcome } from '../agent/call-outcome';

/** Provider-neutral summary of how a call ended. */
export type CallDisposition = 'answered' | 'no-answer' | 'busy' | 'voicemail' | 'failed';

export interface StartCallRequest {
  /** Our Call id. Providers must echo it back in webhooks so we can find the call. */
  callId: string;
  phone: string;
  leadName: string | null;
  timezone: string;
  importNotes: string | null;
  /** Summaries of earlier answered calls with this lead, newest first. */
  previousCalls: PreviousCall[];
}

export interface StartedCall {
  providerCallId: string;
  /** Fingerprint of the agent config (prompt, voice, model) used, to compare versions later. */
  agentVersion?: string;
}

/** The agent called one of our tools in the middle of a call. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResult {
  id: string;
  name: string;
  result: string;
}

export type CallEvent =
  | { type: 'started'; callId: string; providerCallId: string }
  | {
      type: 'ended';
      callId: string;
      providerCallId: string;
      disposition: CallDisposition;
      endedReason: string;
      /** null when the call was not answered or the provider extracted nothing valid */
      outcome: CallOutcome | null;
      rawOutcome: unknown;
      summary: string | null;
      transcript: string | null;
      recordingUrl: string | null;
      /** Average ms from the customer finishing to the agent starting to speak. */
      turnLatencyMs?: number | null;
      /** The provider's per-turn latency breakdown, kept as-is. */
      metrics?: unknown;
    }
  | { type: 'tool-calls'; callId: string; providerCallId: string; toolCalls: ToolCall[] };

/** The seam to a voice AI platform (Vapi, Retell, ...). One implementation per platform. */
export interface VoiceProvider {
  readonly name: string;
  startCall(request: StartCallRequest): Promise<StartedCall>;
  /** True when the webhook request really comes from the provider. */
  isAuthentic(headers: Record<string, string | string[] | undefined>): boolean;
  /** Maps a webhook body to a CallEvent, or null for events we do not care about. */
  parseWebhook(body: unknown): CallEvent | null;
  /** The webhook response body that hands tool results back to the agent. */
  toolResponse(results: ToolResult[]): unknown;
}

export const VOICE_PROVIDER = Symbol('VOICE_PROVIDER');
