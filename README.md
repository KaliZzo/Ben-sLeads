# Talk Leads

An AI voice agent calls a list of phone numbers and offers a free in-home consultation.
- **Interested:** it books a date and time and collects the customer's details.
- **Not interested:** it records why.
- **Results:** every outcome lands in a Google Sheet, one row per lead. Employees read the sheet and go to the appointments.

```
CSV ─▶ Postgres (leads) ─▶ Dialer ─▶ VoiceProvider (Vapi) ─▶ phone call
                             ▲                                    │
                             └──── POST /webhooks/voice ◀─────────┘ end-of-call report
                                         │ lead updated in Postgres (source of truth)
                                         ▼
                                    Sink sync ─▶ LeadSink (Google Sheets)
```

It is deliberately boring: one NestJS app and one Postgres database. There is no Redis or message queue; the lead table is the queue.

## How it works

| Piece | File | What it does |
|---|---|---|
| Agent script | `src/agent/agent-script.ts` | What the agent says. Edit this to change the pitch. |
| Agent tools | `src/agent/agent-tools.ts` | Functions the agent calls mid-call (address check). Answered from the webhook. |
| Call outcome | `src/agent/call-outcome.ts` | The fields extracted after each call. One zod schema is both the extraction instruction and the validator. |
| Lead lifecycle | `src/leads/lead-transitions.ts` | One pure function decides what happens to a lead after a call. |
| Dialer | `src/dialer/dialer.service.ts` | Every 5s, fills free call slots with due leads, inside calling hours. Also fails stale calls. |
| Webhook | `src/calls/` | Receives the provider's events and records the call result, idempotently. |
| Voice port | `src/voice/voice-provider.ts` | The interface each voice platform implements (`vapi/`, `fake/`). |
| Sink port | `src/sink/lead-sink.ts` | The interface each results destination implements (`google-sheets/`, `log/`). |

**Lead states**

```
PENDING ─▶ CALLING ─▶ BOOKED | NOT_INTERESTED | DO_NOT_CALL     (final)
              │      └─▶ NEEDS_HUMAN: asked for a person, wants something the agent can't book,
              │          or asked for a callback with no attempts left. A person follows up.
              └─▶ PENDING again (no answer, busy, voicemail, callback, failure),
                  or UNREACHABLE once MAX_ATTEMPTS is used up
```

**Concurrency.** The number of leads in `CALLING` never exceeds `MAX_CONCURRENT_CALLS`. Set it to your Vapi plan's concurrent-call limit (pay-as-you-go 4, Core 10, plus $10 per extra line per month).

**Reliability**
- **Webhooks:** may arrive more than once; only the first one counts.
- **Lost webhooks:** a call whose end is never reported is marked failed after 20 minutes and retried.
- **Sheet outages:** the sheet is updated from the database every 15s, so an outage delays results but never loses them.

**Single instance.** Run one instance of the app. The dialer and sheet sync assume they are the only ones running. One instance handles hundreds of leads and tens of concurrent calls comfortably.

## Run it locally (no paid services)

```bash
npm install
cp .env.example .env              # defaults: fake voice provider, results logged to the console
docker compose up -d              # Postgres on localhost:55442
npm run db:deploy                 # create tables
npm run import -- leads.csv       # see "Leads CSV" below
npm run start:dev
```

The fake provider simulates calls (answers, bookings, refusals, voicemail) by posting webhooks back to the app.
- Watch progress with `curl localhost:3000/leads/stats`.
- List leads with `curl 'localhost:3000/leads?status=BOOKED'`.

### Leads CSV

```csv
phone,name,timezone,consent,notes
(212) 555-0142,Dana Smith,America/New_York,yes,Asked about pricing last year
+13105550199,Sam Lee,America/Los_Angeles,yes,
```

| Column | Rules |
|---|---|
| `phone` | Any US format; it is normalised. |
| `consent` | Must be `yes`/`true`/`1`, or the row is rejected (see Compliance). |
| `timezone` | Optional. Defaults to `DEFAULT_TIMEZONE`. Used for calling hours and for showing meeting times. |

Duplicate phone numbers are skipped. You can also upload over HTTP:
```bash
curl -X POST localhost:3000/leads/import -H 'content-type: text/csv' --data-binary @leads.csv
```

## Going live

1. **Phone numbers.** Vapi's free numbers cannot make outbound calls.
   - Buy numbers in Twilio (or Telnyx) and import them in the Vapi dashboard under *Phone Numbers*.
   - Put their Vapi ids in `VAPI_PHONE_NUMBER_IDS`, comma-separated; calls rotate across them.
   - Register CNAM and STIR/SHAKEN so calls are not flagged as spam.
2. **Vapi.** Set `VOICE_PROVIDER=vapi` and `VAPI_API_KEY`.
   - The assistant is built from `agent-script.ts` on every call, so there is nothing to configure in the Vapi dashboard.
   - Optionally set `VAPI_LLM_MODEL`, `VAPI_VOICE_ID` and `VAPI_VOICE_VERSION` (defaults: `gpt-5.6-terra`, `Layla`, `2`).
     Set `AGENT_NAME` to match the voice.
   - To try another voice, set `VAPI_VOICE_PROVIDER=11labs` or `cartesia` with its `VAPI_VOICE_ID` and `VAPI_VOICE_MODEL`.
   - Set `TRANSFER_PHONE_NUMBER` to a person's number so callers who ask for a human are put through.
     Without it, those leads become `NEEDS_HUMAN` in the sheet for someone to call back.
3. **Google Sheet.**
   - Create a service account in Google Cloud, enable the Sheets API and download its JSON key to `./google-service-account.json`.
   - Share the spreadsheet with the service account's email as *Editor*.
   - Create a tab named `Leads`, or set `GOOGLE_SHEETS_TAB`.
   - Set `LEAD_SINK=google-sheets` and `GOOGLE_SHEETS_SPREADSHEET_ID` (the long id in the sheet's URL). The header row is written automatically.
4. **Public URL.** Vapi must reach `POST {PUBLIC_BASE_URL}/webhooks/voice`. During development use `ngrok http 3000`.
5. **Secret.** Set `WEBHOOK_SECRET` to a long random value (`openssl rand -hex 32`).
6. **Start.**
   - Production: `npm run build && npm run db:deploy && npm start`.
   - First test with a 3-row CSV of your own numbers. Book once, decline once, and let one ring out.

Sheet columns: Status · Meeting Time (lead's local time) · Name · Phone · Phone 2 · Address · ZIP Code · Notes · Not-Interested Reason · Attempts · Last Call · Call Summary · Recording · Lead ID · Follow-Up Needed · Call Back At.

Check **Follow-Up Needed** daily: it lists `NEEDS_HUMAN` leads and bookings with a missing time or address.

## Conversation quality

- **Latency.** Each call stores `turnLatencyMs` (average time from the customer finishing to the agent speaking) and Vapi's per-turn breakdown in `metrics`.
- **Versions.** Each call stores `agentVersion`, a fingerprint of the prompt, voice, model and settings. Compare versions with:
  ```sql
  SELECT "agentVersion", count(*), avg("turnLatencyMs")::int AS avg_ms, count(*) FILTER (WHERE outcome->>'result' = 'BOOKED') AS booked
  FROM "Call" WHERE status = 'ENDED' GROUP BY 1;
  ```
- **Caller ID reputation.** Unanswered calls and "it says spam" are fixed outside this app.
  - Register CNAM and get A-level STIR/SHAKEN attestation for each number (Twilio Trust Hub).
  - Register the numbers with the free carrier registry (freecallerregistry.com).
  - Use local area codes for the leads you call.

## Adding another provider

- **Voice platform (e.g. Retell):** add `src/voice/retell/retell.provider.ts` implementing `VoiceProvider`.
  - `startCall` places the call and passes our `callId` as metadata the platform echoes back.
  - `parseWebhook` maps the platform's end-of-call payload to a `CallEvent`.
  - Register it in `src/voice/voice.module.ts` and add the value to `VOICE_PROVIDER` in `src/config/env.ts`.
- **Results destination (e.g. a CRM):** implement `LeadSink` and register it in `src/sink/sink.module.ts`.

Nothing else changes.

## Compliance (US)

The FCC ruled in February 2024 that AI-generated voices count as "artificial voice" under the TCPA. Marketing calls with an AI agent therefore need the person's **prior express written consent**. Get legal advice before calling. This app helps:
- It only imports and dials leads marked with consent.
- It calls only between `CALLING_HOURS_START` and `CALLING_HOURS_END` in the lead's local time.
- The agent says it is an AI.
- A "don't call me again" request moves the lead to `DO_NOT_CALL` permanently.

You are still responsible for checking numbers against the National Do Not Call Registry.

## Tests

```bash
npm test            # unit tests: lead lifecycle, Vapi payload mapping
npm run test:e2e    # needs `docker compose up -d`; uses a separate talk_test database
```

The e2e tests cover:
- CSV import
- the concurrency cap
- calling hours and consent
- webhook idempotency and authentication
- retries and giving up
- provider failures and stale calls
- sheet sync
