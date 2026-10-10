import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { ENV, loadEnv, type Env } from '../src/config/env';
import { DialerService } from '../src/dialer/dialer.service';
import { CallStatus, LeadStatus } from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';
import { LEAD_SINK, type LeadSink, type LeadView } from '../src/sink/lead-sink';
import { SinkSyncService } from '../src/sink/sink-sync.service';
import { VOICE_PROVIDER, type StartCallRequest, type ToolResult, type VoiceProvider } from '../src/voice/voice-provider';
import { FakeVoiceProvider } from '../src/voice/fake/fake.provider';
import { TEST_DATABASE_URL } from './test-env';

const SECRET = 'test-secret-0123456789';

/** Records calls instead of placing them; webhooks are parsed like the fake provider's. */
class RecordingProvider implements VoiceProvider {
  readonly name = 'test';
  started: StartCallRequest[] = [];
  failNext = false;
  private readonly parser: FakeVoiceProvider;

  constructor(env: Env) {
    this.parser = new FakeVoiceProvider(env);
  }

  async startCall(req: StartCallRequest) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('provider down');
    }
    this.started.push(req);
    return { providerCallId: `prov-${req.callId}` };
  }
  isAuthentic = (headers: Record<string, string | string[] | undefined>) => this.parser.isAuthentic(headers);
  parseWebhook = (body: unknown) => this.parser.parseWebhook(body);
  toolResponse = (results: ToolResult[]) => this.parser.toolResponse(results);
}

class RecordingSink implements LeadSink {
  readonly name = 'test';
  upserts: { lead: LeadView; ref: string | null }[] = [];
  async upsert(lead: LeadView, ref: string | null) {
    this.upserts.push({ lead, ref });
    return ref ?? `row-${this.upserts.length}`;
  }
}

describe('Lead calling flow (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let dialer: DialerService;
  let sync: SinkSyncService;
  let env: Env;
  let provider: RecordingProvider;
  let sink: RecordingSink;

  beforeAll(async () => {
    env = loadEnv({
      DATABASE_URL: TEST_DATABASE_URL,
      PUBLIC_BASE_URL: 'http://localhost:0',
      WEBHOOK_SECRET: SECRET,
      DIALER_ENABLED: 'false',
      MAX_CONCURRENT_CALLS: '3',
      MAX_ATTEMPTS: '2',
      CALLING_HOURS_START: '0',
      CALLING_HOURS_END: '24',
    });
    provider = new RecordingProvider(env);
    sink = new RecordingSink();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENV)
      .useValue(env)
      .overrideProvider(VOICE_PROVIDER)
      .useValue(provider)
      .overrideProvider(LEAD_SINK)
      .useValue(sink)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    // Drive the dialer and sync by hand instead of on timers.
    const scheduler = app.get(SchedulerRegistry);
    for (const name of scheduler.getIntervals()) scheduler.deleteInterval(name);

    prisma = app.get(PrismaService);
    dialer = app.get(DialerService);
    sync = app.get(SinkSyncService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.call.deleteMany();
    await prisma.lead.deleteMany();
    provider.started = [];
    sink.upserts = [];
    env.CALLING_HOURS_START = 0;
    env.CALLING_HOURS_END = 24;
  });

  async function createLeads(count: number, overrides: { timezone?: string; consent?: boolean } = {}) {
    await prisma.lead.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        phone: `+1415555${String(i).padStart(4, '0')}`,
        name: `Lead ${i}`,
        timezone: overrides.timezone ?? 'America/New_York',
        consent: overrides.consent ?? true,
        nextAttemptAt: new Date(Date.now() - 1_000), // due now, whatever the app/database clock skew
      })),
    });
  }

  /** Makes every lead due now. A second in the past, so clock skew with the database cannot matter. */
  function makeAllDue() {
    return prisma.lead.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
  }

  function endCall(callId: string, disposition: string, outcome?: unknown, secret = SECRET) {
    return request(app.getHttpServer())
      .post('/webhooks/voice')
      .set('x-webhook-secret', secret)
      .send({ fake: true, callId, providerCallId: `prov-${callId}`, disposition, outcome });
  }

  it('imports a CSV, normalising phones and rejecting bad rows', async () => {
    const csv = [
      'phone,name,timezone,consent,notes',
      '(415) 555-0100,Dana,America/Los_Angeles,yes,VIP',
      '415-555-0100,Dana again,,yes,',
      '12,Bad Phone,,yes,',
      '415-555-0101,No Consent,,no,',
      '415-555-0102,Bad Zone,Mars/Olympus,yes,',
    ].join('\n');

    const res = await request(app.getHttpServer()).post('/leads/import').set('content-type', 'text/csv').send(csv);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: 1, duplicates: 1 });
    expect(res.body.rejected.map((r: { line: number }) => r.line)).toEqual([4, 5, 6]);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { phone: '+14155550100' } });
    expect(lead).toMatchObject({ name: 'Dana', timezone: 'America/Los_Angeles', importNotes: 'VIP' });
  });

  it('dials phone2 when phone is not answered, and stops once someone answers', async () => {
    const csv = ['phone,phone2,name,consent', '415-555-0200,415-555-0201,Dana,yes'].join('\n');
    await request(app.getHttpServer()).post('/leads/import').set('content-type', 'text/csv').send(csv).expect(201);

    await dialer.dialDueLeads();
    expect(provider.started.map((s) => s.phone)).toEqual(['+14155550200']);
    await endCall(provider.started[0].callId, 'no-answer').expect(200);

    await dialer.dialDueLeads();
    expect(provider.started.map((s) => s.phone)).toEqual(['+14155550200', '+14155550201']);
    await endCall(provider.started[1].callId, 'answered', { result: 'NOT_INTERESTED' }).expect(200);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { phone: '+14155550200' }, include: { calls: true } });
    expect(lead).toMatchObject({ status: LeadStatus.NOT_INTERESTED, attempts: 1, altPhone: '+14155550201' });
    expect(lead.calls.map((c) => c.phone).sort()).toEqual(['+14155550200', '+14155550201']);
    expect(await dialer.dialDueLeads()).toBe(0);
  });

  it('never runs more calls than MAX_CONCURRENT_CALLS', async () => {
    await createLeads(10);

    expect(await dialer.dialDueLeads()).toBe(3);
    expect(await dialer.dialDueLeads()).toBe(0); // all slots busy
    expect(await prisma.lead.count({ where: { status: LeadStatus.CALLING } })).toBe(3);

    await endCall(provider.started[0].callId, 'no-answer').expect(200);
    expect(await dialer.dialDueLeads()).toBe(1); // exactly the freed slot
    expect(provider.started).toHaveLength(4);
  });

  it('does not dial leads outside calling hours, without consent, or not yet due', async () => {
    const hour = new Date().getUTCHours();
    env.CALLING_HOURS_START = hour === 23 ? 0 : hour + 1;
    env.CALLING_HOURS_END = hour === 23 ? 23 : 24;
    await createLeads(1, { timezone: 'UTC' });
    expect(await dialer.dialDueLeads()).toBe(0);

    env.CALLING_HOURS_START = 0;
    env.CALLING_HOURS_END = 24;
    await prisma.lead.updateMany({ data: { consent: false } });
    expect(await dialer.dialDueLeads()).toBe(0);

    await prisma.lead.updateMany({ data: { consent: true, nextAttemptAt: new Date(Date.now() + 60_000) } });
    expect(await dialer.dialDueLeads()).toBe(0);
  });

  it('books a meeting from the webhook and ignores a duplicate delivery', async () => {
    await createLeads(1);
    await dialer.dialDueLeads();
    const { callId } = provider.started[0];
    const outcome = { result: 'BOOKED', meetingAt: '2026-10-07T10:30:00-04:00', customerName: 'Dana Smith', address: '1 Main St', zipCode: '62701' };

    await endCall(callId, 'answered', outcome).expect(200);
    await endCall(callId, 'no-answer').expect(200); // duplicate/late event must change nothing

    const lead = await prisma.lead.findFirstOrThrow({ include: { calls: true } });
    expect(lead).toMatchObject({
      status: LeadStatus.BOOKED,
      meetingAt: new Date('2026-10-07T14:30:00Z'),
      customerName: 'Dana Smith',
      address: '1 Main St',
      zipCode: '62701',
      attempts: 1,
      revision: 1,
    });
    expect(lead.calls[0]).toMatchObject({ status: CallStatus.ENDED, endedReason: 'fake-answered', providerCallId: `prov-${callId}` });
  });

  it('hands a lead to the team when the customer asks for a person, and shows why in the sink', async () => {
    await createLeads(1);
    await dialer.dialDueLeads();
    const outcome = { result: 'NEEDS_HUMAN', followUpReason: 'Wants to schedule repair work', callbackAt: '2026-10-07T14:00:00-04:00' };
    await endCall(provider.started[0].callId, 'answered', outcome).expect(200);

    const lead = await prisma.lead.findFirstOrThrow();
    expect(lead).toMatchObject({
      status: LeadStatus.NEEDS_HUMAN,
      followUpReason: 'Wants to schedule repair work',
      callbackAt: new Date('2026-10-07T18:00:00Z'),
    });
    await makeAllDue();
    expect(await dialer.dialDueLeads()).toBe(0); // a person calls, not the agent

    await sync.syncPending();
    expect(sink.upserts[0].lead).toMatchObject({ status: LeadStatus.NEEDS_HUMAN, followUpReason: 'Wants to schedule repair work' });
  });

  it("answers the agent's tool calls in the webhook response", async () => {
    await createLeads(1);
    await dialer.dialDueLeads();
    const { callId } = provider.started[0];
    const res = await request(app.getHttpServer())
      .post('/webhooks/voice')
      .set('x-webhook-secret', SECRET)
      .send({ fake: true, tool: true, callId, providerCallId: `prov-${callId}`, toolCalls: [{ id: 'tc1', name: 'check_address', arguments: {} }] })
      .expect(200);
    expect(res.body).toEqual({ results: [{ id: 'tc1', name: 'check_address', result: expect.stringContaining('full street address') }] });
  });

  it('rejects webhooks without the shared secret', async () => {
    await endCall('anything', 'answered', undefined, 'wrong-secret-0000000000').expect(401);
  });

  it('retries unanswered leads and gives up after MAX_ATTEMPTS', async () => {
    await createLeads(1);

    await dialer.dialDueLeads();
    await endCall(provider.started[0].callId, 'voicemail').expect(200);
    let lead = await prisma.lead.findFirstOrThrow();
    expect(lead.status).toBe(LeadStatus.PENDING);
    expect(lead.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await makeAllDue();
    await dialer.dialDueLeads();
    await endCall(provider.started[1].callId, 'no-answer').expect(200);
    lead = await prisma.lead.findFirstOrThrow();
    expect(lead).toMatchObject({ status: LeadStatus.UNREACHABLE, attempts: 2 });
  });

  it('frees the slot and schedules a retry when the provider rejects the call', async () => {
    await createLeads(1);
    provider.failNext = true;

    await dialer.dialDueLeads();

    const lead = await prisma.lead.findFirstOrThrow({ include: { calls: true } });
    expect(lead.status).toBe(LeadStatus.PENDING);
    expect(lead.calls[0].status).toBe(CallStatus.FAILED);
  });

  it('fails calls whose end-of-call webhook never arrives', async () => {
    await createLeads(1);
    await dialer.dialDueLeads();
    await prisma.call.updateMany({ data: { startedAt: new Date(Date.now() - 60 * 60_000) } });

    await dialer.failStaleCalls();

    const lead = await prisma.lead.findFirstOrThrow({ include: { calls: true } });
    expect(lead.status).toBe(LeadStatus.PENDING);
    expect(lead.calls[0]).toMatchObject({ status: CallStatus.FAILED, endedReason: 'stale' });
  });

  it('syncs each change to the sink once, reusing the returned ref', async () => {
    await createLeads(1);
    expect(await sync.syncPending()).toBe(0); // nothing to show before the first call ends

    await dialer.dialDueLeads();
    await endCall(provider.started[0].callId, 'answered', { result: 'CALLBACK' }).expect(200);
    expect(await sync.syncPending()).toBe(1);
    expect(await sync.syncPending()).toBe(0);

    await makeAllDue();
    await dialer.dialDueLeads();
    await endCall(provider.started[1].callId, 'answered', { result: 'NOT_INTERESTED', notInterestedReason: 'Too expensive' }).expect(200);
    expect(await sync.syncPending()).toBe(1);

    expect(sink.upserts.map((u) => [u.lead.status, u.ref])).toEqual([
      [LeadStatus.PENDING, null],
      [LeadStatus.NOT_INTERESTED, 'row-1'],
    ]);
    expect(sink.upserts[1].lead.notInterestedReason).toBe('Too expensive');
  });
});
