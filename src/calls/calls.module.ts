import { Module } from '@nestjs/common';
import { AgentToolsService } from '../agent/agent-tools';
import { VoiceModule } from '../voice/voice.module';
import { CallsService } from './calls.service';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [VoiceModule],
  controllers: [WebhookController],
  providers: [CallsService, AgentToolsService],
  exports: [CallsService],
})
export class CallsModule {}
