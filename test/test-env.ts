/** A separate database so tests never touch development data. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://talk:talk@localhost:55442/talk_test';
