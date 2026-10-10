import type { Env } from '../../config/env';
import type { CallEvent, StartCallRequest, StartedCall, ToolResult, VoiceProvider } from '../voice-provider';
import { hasWebhookSecret } from '../webhook-secret';
import { buildCreateCallBody, buildToolResponse, parseVapiWebhook } from './vapi.mapper';

const VAPI_API = 'https://api.vapi.ai';

export class VapiVoiceProvider implements VoiceProvider {
  readonly name = 'vapi';
  private nextNumber = 0;

  constructor(private readonly env: Env) {}

  async startCall(request: StartCallRequest): Promise<StartedCall> {
    const { body, agentVersion } = buildCreateCallBody(request, {
      phoneNumberId: this.pickPhoneNumberId(),
      agentName: this.env.AGENT_NAME,
      llmModel: this.env.VAPI_LLM_MODEL,
      voice: {
        provider: this.env.VAPI_VOICE_PROVIDER,
        voiceId: this.env.VAPI_VOICE_ID,
        version: this.env.VAPI_VOICE_VERSION,
        model: this.env.VAPI_VOICE_MODEL,
      },
      transcriberModel: this.env.VAPI_TRANSCRIBER_MODEL,
      transferNumber: this.env.TRANSFER_PHONE_NUMBER,
      webhookUrl: `${this.env.PUBLIC_BASE_URL}/webhooks/voice`,
      webhookSecret: this.env.WEBHOOK_SECRET,
      now: new Date(),
    });

    const response = await fetch(`${VAPI_API}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.env.VAPI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Vapi rejected the call: HTTP ${response.status} ${await response.text()}`);
    }

    const call = (await response.json()) as { id: string };
    return { providerCallId: call.id, agentVersion };
  }

  isAuthentic(headers: Record<string, string | string[] | undefined>): boolean {
    return hasWebhookSecret(headers, this.env.WEBHOOK_SECRET);
  }

  parseWebhook(body: unknown): CallEvent | null {
    return parseVapiWebhook(body);
  }

  toolResponse(results: ToolResult[]): unknown {
    return buildToolResponse(results);
  }

  /** Spreads calls across the caller IDs to reduce spam labelling. */
  private pickPhoneNumberId(): string {
    const ids = this.env.VAPI_PHONE_NUMBER_IDS;
    const id = ids[this.nextNumber % ids.length];
    this.nextNumber++;
    return id;
  }
}
