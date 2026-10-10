import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { CallsModule } from './calls/calls.module';
import { ConfigModule } from './config/config.module';
import { DialerModule } from './dialer/dialer.module';
import { LeadsModule } from './leads/leads.module';
import { PrismaModule } from './prisma/prisma.module';
import { SinkModule } from './sink/sink.module';

@Module({
  imports: [ScheduleModule.forRoot(), ConfigModule, PrismaModule, LeadsModule, CallsModule, DialerModule, SinkModule],
  controllers: [AppController],
})
export class AppModule {}
