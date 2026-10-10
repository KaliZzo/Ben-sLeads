import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { GoogleSheetsSink } from './google-sheets/google-sheets.sink';
import { LEAD_SINK, type LeadSink } from './lead-sink';
import { LogSink } from './log/log.sink';
import { SinkSyncService } from './sink-sync.service';

/** Picks the results destination from LEAD_SINK. Add new destinations here. */
@Module({
  providers: [
    {
      provide: LEAD_SINK,
      inject: [ENV],
      useFactory: (env: Env): LeadSink => {
        switch (env.LEAD_SINK) {
          case 'google-sheets':
            return new GoogleSheetsSink(env);
          case 'log':
            return new LogSink();
        }
      },
    },
    SinkSyncService,
  ],
  exports: [SinkSyncService],
})
export class SinkModule {}
