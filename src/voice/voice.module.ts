import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { FakeVoiceProvider } from './fake/fake.provider';
import { VapiVoiceProvider } from './vapi/vapi.provider';
import { VOICE_PROVIDER, type VoiceProvider } from './voice-provider';

/** Picks the voice platform from VOICE_PROVIDER. Add new platforms here. */
@Module({
  providers: [
    {
      provide: VOICE_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env): VoiceProvider => {
        switch (env.VOICE_PROVIDER) {
          case 'vapi':
            return new VapiVoiceProvider(env);
          case 'fake':
            return new FakeVoiceProvider(env);
        }
      },
    },
  ],
  exports: [VOICE_PROVIDER],
})
export class VoiceModule {}
