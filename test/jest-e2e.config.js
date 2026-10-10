/** End-to-end tests: need the Postgres from docker-compose (`docker compose up -d`). */
module.exports = {
  testEnvironment: 'node',
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  globalSetup: '<rootDir>/test/global-setup.ts',
};
