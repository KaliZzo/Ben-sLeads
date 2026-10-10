import { BadRequestException, Body, Controller, Get, ParseEnumPipe, Post, Query } from '@nestjs/common';
import { LeadStatus } from '../generated/prisma/enums';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  /** Send the CSV file as the request body with Content-Type: text/csv. */
  @Post('import')
  importCsv(@Body() csv: unknown) {
    if (typeof csv !== 'string' || csv.trim() === '') {
      throw new BadRequestException('Send the CSV as the body with Content-Type: text/csv');
    }
    return this.leads.importCsv(csv);
  }

  @Get('stats')
  stats() {
    return this.leads.countByStatus();
  }

  @Get()
  list(@Query('status', new ParseEnumPipe(LeadStatus, { optional: true })) status?: LeadStatus) {
    return this.leads.list(status);
  }
}
