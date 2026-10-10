import { AgentToolsService, describeAddressCheck } from './agent-tools';

const concord = { matchedAddress: '1699 BAYWOOD DR, CONCORD, CA, 94521', zip: '94521', county: 'Contra Costa County' };
const salinas = { matchedAddress: '100 N MAIN ST, SALINAS, CA, 93901', zip: '93901', county: 'Monterey County' };

describe('describeAddressCheck', () => {
  it('confirms an address inside the service area, with its ZIP code', () => {
    const answer = describeAddressCheck('1699 Baywood Concord', [concord]);
    expect(answer).toContain('1699 BAYWOOD DR, CONCORD, CA, 94521');
    expect(answer).toContain('Inside our service area');
  });

  it('tells the agent not to book outside the service area', () => {
    expect(describeAddressCheck('100 Main St Salinas', [salinas])).toContain("outside our usual service area. Don't book it");
  });

  it('asks the agent to re-check a misheard address', () => {
    expect(describeAddressCheck('63 Neshwin Fauna Makatas', [])).toContain('may have been misheard');
  });

  it('falls back to reading the address back when the geocoder is down', () => {
    expect(describeAddressCheck('1 Main St', null)).toContain('unavailable');
  });
});

describe('AgentToolsService', () => {
  const tools = new AgentToolsService();

  it('answers bad arguments and unknown tools with an instruction instead of throwing', async () => {
    await expect(tools.run('check_address', {})).resolves.toContain('Ask the customer for the full street address');
    await expect(tools.run('book_helicopter', {})).resolves.toContain('not available');
  });
});
