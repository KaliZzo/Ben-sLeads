import { execSync } from 'node:child_process';
import { Client } from 'pg';
import { TEST_DATABASE_URL } from './test-env';

export default async function globalSetup() {
  const url = new URL(TEST_DATABASE_URL);
  const database = url.pathname.slice(1);
  url.pathname = '/postgres';

  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();

  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: 'ignore' });
}
