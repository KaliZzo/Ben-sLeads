import { Body, Controller, Headers, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { VOICE_PROVIDER, type VoiceProvider } from '../voice/voice-provider';
import { CallsService } from './calls.service';

@Controller('webhooks')
export class WebhookController {
  constructor(
    @Inject(VOICE_PROVIDER) private readonly provider: VoiceProvider,
    private readonly calls: CallsService,
  ) {}

  @Post('voice')
  @HttpCode(200)
  async voice(@Headers() headers: Record<string, string | string[] | undefined>, @Body() body: unknown) {
    if (!this.provider.isAuthentic(headers)) throw new UnauthorizedException();

    const event = this.provider.parseWebhook(body);
    if (!event) return { ok: true };
    const toolResults = await this.calls.handleEvent(event);
    return toolResults ? this.provider.toolResponse(toolResults) : { ok: true };
  }
}
