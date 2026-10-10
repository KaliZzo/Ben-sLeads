/**
 * Imports leads from a CSV file.
 *   npm run import -- path/to/leads.csv
 * Columns: phone, phone2 (optional), name, timezone (optional), consent, notes (optional)
 */
import 'dotenv/config';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { ConfigModule } from '../src/config/config.module';
import { LeadsModule } from '../src/leads/leads.module';
import { LeadsService } from '../src/leads/leads.service';
import { PrismaModule } from '../src/prisma/prisma.module';

@Module({ imports: [ConfigModule, PrismaModule, LeadsModule] })
class ImportModule {}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run import -- path/to/leads.csv');

  const app = await NestFactory.createApplicationContext(ImportModule, { logger: ['error', 'warn'] });
  try {
    const report = await app.get(LeadsService).importCsv(readFileSync(file, 'utf8'));
    console.log(`Imported ${report.imported}, skipped ${report.duplicates} duplicates, rejected ${report.rejected.length}`);
    for (const { line, reason } of report.rejected) console.log(`  line ${line}: ${reason}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
