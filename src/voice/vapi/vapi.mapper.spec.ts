import endOfCallReport from './fixtures/end-of-call-report.json';
import { END_CALL_PHRASE } from '../../agent/agent-script';
import { buildCreateCallBody, buildToolResponse, mapEndedReason, OUTCOME_OUTPUT_NAME, parseVapiWebhook } from './vapi.mapper';

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('parseVapiWebhook', () => {
  it('maps an end-of-call report to an ended event with the extracted outcome', () => {
    expect(parseVapiWebhook(endOfCallReport)).toEqual({
      type: 'ended',
      callId: 'our-call-1',
      providerCallId: 'vapi-call-123',
      disposition: 'answered',
      endedReason: 'customer-ended-call',
      outcome: {
        result: 'BOOKED',
        meetingAt: '2026-10-07T10:30:00-04:00',
        customerName: 'Dana Smith',
        address: '1 Main St, Springfield',
      },
      rawOutcome: endOfCallReport.message.artifact.structuredOutputs['5f0c1e2a-0000-4000-8000-000000000001'].result,
      summary: 'Customer booked a visit for Wednesday morning.',
      transcript: 'AI: Hi Dana...\nUser: Sure, Wednesday at 10:30 works.',
      recordingUrl: 'https://storage.vapi.ai/combined.wav',
      turnLatencyMs: 1830,
      metrics: endOfCallReport.message.artifact.performanceMetrics,
    });
  });

  it('reads our call id from message.assistant when the call object lacks it', () => {
    const body = clone(endOfCallReport) as any;
    delete body.message.call.assistant;
    body.message.assistant = { metadata: { callId: 'our-call-2' } };
    expect(parseVapiWebhook(body)).toMatchObject({ callId: 'our-call-2' });
  });

  it('keeps the end event but drops an outcome that does not match the schema', () => {
    const body = clone(endOfCallReport) as any;
    body.message.artifact.structuredOutputs['5f0c1e2a-0000-4000-8000-000000000001'].result = { result: 'MAYBE' };
    expect(parseVapiWebhook(body)).toMatchObject({ type: 'ended', outcome: null, rawOutcome: { result: 'MAYBE' } });
  });

  it('maps an unanswered call with no structured output', () => {
    const body = clone(endOfCallReport) as any;
    body.message.endedReason = 'customer-did-not-answer';
    delete body.message.artifact;
    expect(parseVapiWebhook(body)).toMatchObject({ disposition: 'no-answer', outcome: null, recordingUrl: null, turnLatencyMs: null });
  });

  it('turns an in-progress status update into a started event', () => {
    const body = { message: { type: 'status-update', status: 'in-progress', call: endOfCallReport.message.call } };
    expect(parseVapiWebhook(body)).toEqual({ type: 'started', callId: 'our-call-1', providerCallId: 'vapi-call-123' });
  });

  it('ignores other events, calls we did not start and malformed bodies', () => {
    expect(parseVapiWebhook({ message: { type: 'status-update', status: 'ringing', call: endOfCallReport.message.call } })).toBeNull();
    expect(parseVapiWebhook({ message: { type: 'end-of-call-report', call: { id: 'x' } } })).toBeNull();
    expect(parseVapiWebhook({ hello: 'world' })).toBeNull();
  });
});

describe('mapEndedReason', () => {
  it.each([
    ['customer-ended-call', 'answered'],
    ['assistant-ended-call', 'answered'],
    ['silence-timed-out', 'answered'],
    ['customer-did-not-answer', 'no-answer'],
    ['customer-busy', 'busy'],
    ['voicemail', 'voicemail'],
    ['twilio-failed-to-connect-call', 'failed'],
    ['pipeline-error-openai-llm-failed', 'failed'],
    ['some-reason-added-next-year', 'failed'],
  ])('%s -> %s', (reason, disposition) => {
    expect(mapEndedReason(reason)).toBe(disposition);
  });
});

describe('buildCreateCallBody', () => {
  const request = {
    callId: 'our-call-1',
    phone: '+14155550123',
    leadName: 'Dana',
    timezone: 'America/Los_Angeles',
    importNotes: null,
    previousCalls: [],
  };
  const options = {
    phoneNumberId: 'pn_1',
    agentName: 'Layla',
    companyName: null,
    llmModel: 'gpt-5.6-terra',
    voice: { provider: 'vapi' as const, voiceId: 'Layla', version: '2' as const },
    transcriberModel: 'flux-general-en',
    webhookUrl: 'https://example.com/webhooks/voice',
    webhookSecret: 'secret',
    now: new Date('2026-10-05T17:00:00Z'),
  };
  const { body, agentVersion } = buildCreateCallBody(request, options);
  const prompt = body.assistant.model.messages[0].content;
  const toolTypes = (tools: Record<string, unknown>[]) => tools.map((tool) => tool.type);

  it('carries our call id, the webhook secret and the outcome schema', () => {
    expect(body.phoneNumberId).toBe('pn_1');
    expect(body.customer).toEqual({ number: '+14155550123', name: 'Dana' });
    expect(body.assistant.metadata).toEqual({ callId: 'our-call-1' });
    expect(body.assistant.server).toEqual({ url: 'https://example.com/webhooks/voice', headers: { 'x-webhook-secret': 'secret' } });
    expect(body.assistant.artifactPlan.structuredOutputs[0]).toMatchObject({ name: OUTCOME_OUTPUT_NAME });
  });

  it('greets right away with a short hello, then introduces itself once they answer', () => {
    expect(body.assistant.firstMessageMode).toBe('assistant-speaks-first');
    expect(body.assistant.firstMessage).toBe('Hi, is this Dana?');
    expect(body.assistant.firstMessageInterruptionsEnabled).toBe(true);
    expect(body.assistant.stopSpeakingPlan.interruptionPhrases).toEqual(expect.arrayContaining(['hello', 'who', 'stop', 'wait']));
    expect(prompt).toContain('you said: "Hi, is this Dana?"');
    expect(prompt).toContain(
      "\"Hi! This is Layla with the local chimney team, about chimney inspections in your area. I know I'm calling out of the blue. Do you have twenty seconds?\"",
    );
    const { body: noName } = buildCreateCallBody({ ...request, leadName: null }, options);
    expect(noName.assistant.firstMessage).toBe('Hello?');
  });

  it('names the business when one is configured, and never claims the lead signed up', () => {
    const { body: named } = buildCreateCallBody({ ...request, leadName: null }, { ...options, companyName: 'Bay Chimney Co' });
    expect(named.assistant.model.messages[0].content).toContain('This is Layla with Bay Chimney Co, about chimney inspections');
    expect(named.assistant.model.messages[0].content).toContain('Only use the business name "Bay Chimney Co"');
    expect(prompt).not.toMatch(/you shared your (info|details)/i);
  });

  it("doesn't volunteer that it's an AI, but admits it when asked and offers a person", () => {
    expect(body.assistant.firstMessage).not.toMatch(/\bAI\b|assistant/i);
    expect(prompt).toContain('only talk about being an AI if the customer asks');
    expect(prompt).toContain('never deny it');
    expect(prompt).toContain('I can have someone call you back as soon as possible');
  });

  it('hangs up when the agent says its closing line', () => {
    expect(body.assistant.endCallPhrases).toEqual([END_CALL_PHRASE]);
    expect(prompt).toContain(END_CALL_PHRASE);
  });

  it('uses the configured model without reasoning, on the fast tier, and the Vapi voice version', () => {
    expect(body.assistant.model).toMatchObject({ provider: 'openai', model: 'gpt-5.6-terra', reasoningEffort: 'none', serviceTier: 'fast' });
    expect(body.assistant.voice).toEqual({ provider: 'vapi', voiceId: 'Layla', version: '2' });
  });

  it('passes a model for third-party voices and no Vapi version', () => {
    const { body: other } = buildCreateCallBody(request, {
      ...options,
      voice: { provider: '11labs', voiceId: 'abc', version: '2', model: 'eleven_flash_v2_5' },
    });
    expect(other.assistant.voice).toEqual({ provider: '11labs', voiceId: 'abc', model: 'eleven_flash_v2_5', stability: 0.4 });
  });

  it('lets Flux detect the end of a turn, and adds smart endpointing for other transcribers', () => {
    expect(body.assistant.transcriber).toMatchObject({ provider: 'deepgram', model: 'flux-general-en' });
    expect(body.assistant.transcriber.keyterm).toContain('chimney');
    expect(body.assistant.startSpeakingPlan).not.toHaveProperty('smartEndpointingPlan');
    const { body: nova } = buildCreateCallBody(request, { ...options, transcriberModel: 'nova-3' });
    expect(nova.assistant.startSpeakingPlan).toMatchObject({ smartEndpointingPlan: { provider: 'livekit' } });
  });

  it('plays quiet office ambience so the line never sounds dead', () => {
    expect(body.assistant.backgroundSound).toBe('office');
  });

  it('offers the address check tool, and a transfer only when a number is configured', () => {
    expect(toolTypes(body.assistant.model.tools)).toEqual(['endCall', 'function']);
    expect(body.assistant.serverMessages).toContain('tool-calls');
    expect(prompt).not.toContain('`transferCall`');

    const { body: withTransfer } = buildCreateCallBody(request, { ...options, transferNumber: '+14155550999' });
    expect(toolTypes(withTransfer.assistant.model.tools)).toEqual(['endCall', 'function', 'transferCall']);
    expect(withTransfer.assistant.model.tools[2]).toMatchObject({ destinations: [{ type: 'number', number: '+14155550999' }] });
    expect(withTransfer.assistant.model.messages[0].content).toContain('`transferCall`');
  });

  it('sends a plain JSON schema without the $schema key, which Vapi rejects', () => {
    const { schema } = body.assistant.artifactPlan.structuredOutputs[0];
    expect(schema).not.toHaveProperty('$schema');
    expect(schema).toMatchObject({ type: 'object', required: ['result'] });
  });

  it("tells the agent the current time and the coming dates in the lead's timezone", () => {
    expect(prompt).toContain('Monday, October 5, 2026 at 10:00 AM (America/Los_Angeles)');
    expect(prompt).toContain('- Tuesday, October 6: say "tomorrow"');
    expect(prompt).toContain('- Thursday, October 8: say "this Thursday"');
    expect(prompt).toContain('- Sunday, October 18: say "next Sunday"');
    expect(prompt).toContain('Never say "AM," "PM"');
  });

  it('includes what earlier calls were about', () => {
    const { body: retry } = buildCreateCallBody(
      { ...request, previousCalls: [{ at: new Date('2026-10-03T20:00:00Z'), summary: 'Asked to call back after the weekend.' }] },
      options,
    );
    expect(retry.assistant.model.messages[0].content).toContain('- Oct 3: Asked to call back after the weekend.');
  });

  it('fingerprints the agent config but not the per-call details', () => {
    expect(agentVersion).toMatch(/^[0-9a-f]{12}$/);
    const otherLead = buildCreateCallBody(
      { ...request, callId: 'our-call-2', leadName: 'Sam Lee', phone: '+14155550124', importNotes: 'VIP' },
      { ...options, now: new Date('2026-10-06T18:00:00Z') },
    );
    expect(otherLead.agentVersion).toBe(agentVersion);
    expect(buildCreateCallBody(request, { ...options, llmModel: 'gpt-5.6-luna' }).agentVersion).not.toBe(agentVersion);
  });
});

describe('tool calls', () => {
  const call = endOfCallReport.message.call;

  it('maps a tool-calls webhook, with object or JSON-string arguments', () => {
    const body = {
      message: {
        type: 'tool-calls',
        call,
        toolCallList: [
          { id: 'tc1', function: { name: 'check_address', arguments: { address: '1 Main St' } } },
          { id: 'tc2', function: { name: 'check_address', arguments: '{"address":"2 Main St"}' } },
        ],
      },
    };
    expect(parseVapiWebhook(body)).toEqual({
      type: 'tool-calls',
      callId: 'our-call-1',
      providerCallId: 'vapi-call-123',
      toolCalls: [
        { id: 'tc1', name: 'check_address', arguments: { address: '1 Main St' } },
        { id: 'tc2', name: 'check_address', arguments: { address: '2 Main St' } },
      ],
    });
  });

  it("answers in Vapi's results format", () => {
    expect(buildToolResponse([{ id: 'tc1', name: 'check_address', result: 'Found.' }])).toEqual({
      results: [{ toolCallId: 'tc1', name: 'check_address', result: 'Found.' }],
    });
  });
});
