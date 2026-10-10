import { Module } from '@nestjs/common';
import { CallsModule } from '../calls/calls.module';
import { VoiceModule } from '../voice/voice.module';
import { DialerService } from './dialer.service';

@Module({
  imports: [CallsModule, VoiceModule],
  providers: [DialerService],
  exports: [DialerService],
})
export class DialerModule {}
