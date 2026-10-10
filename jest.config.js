/** Unit tests: fast, no database. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '\\.spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
};
