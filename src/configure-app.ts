import type { NestExpressApplication } from '@nestjs/platform-express';

/** HTTP setup shared by the real server and the e2e tests. */
export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser('text', { type: 'text/csv', limit: '5mb' });
  // Vapi's end-of-call report carries the whole transcript and message log, far over the 100kb default.
  app.useBodyParser('json', { limit: '10mb' });
  app.enableShutdownHooks();
}
