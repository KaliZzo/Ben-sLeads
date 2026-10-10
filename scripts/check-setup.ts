/**
 * Verifies credentials without placing a call.
 *   npm run check
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { loadEnv } from '../src/config/env';

async function checkVapi(apiKey: string, phoneNumberIds: string[]) {
  for (const id of phoneNumberIds) {
    const response = await fetch(`https://api.vapi.ai/phone-number/${id}`, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!response.ok) throw new Error(`Vapi phone number ${id}: HTTP ${response.status} ${await response.text()}`);
    const number = (await response.json()) as { number?: string; provider?: string };
    console.log(`✔ Vapi: phone number ${id} = ${number.number} (${number.provider})`);
  }
}

async function checkSheets(keyFile: string, spreadsheetId: string, tab: string) {
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const { data } = await sheets.spreadsheets.get({ spreadsheetId, fields: 'properties.title,sheets.properties.title' });
  const tabs = data.sheets?.map((sheet) => sheet.properties?.title) ?? [];
  if (!tabs.includes(tab)) throw new Error(`Sheet "${data.properties?.title}" has no tab named "${tab}" (tabs: ${tabs.join(', ')})`);
  console.log(`✔ Google Sheets: "${data.properties?.title}" → tab "${tab}" is reachable`);
}

async function main() {
  const env = loadEnv();
  console.log(`✔ .env is valid (voice: ${env.VOICE_PROVIDER}, sink: ${env.LEAD_SINK}, webhook: ${env.PUBLIC_BASE_URL})`);
  if (env.VOICE_PROVIDER === 'vapi') await checkVapi(env.VAPI_API_KEY!, env.VAPI_PHONE_NUMBER_IDS);
  if (env.LEAD_SINK === 'google-sheets') {
    await checkSheets(env.GOOGLE_APPLICATION_CREDENTIALS!, env.GOOGLE_SHEETS_SPREADSHEET_ID!, env.GOOGLE_SHEETS_TAB);
  }
}

main().catch((error) => {
  console.error(`✘ ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
