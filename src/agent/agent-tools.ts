import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { SERVICE_AREA_COUNTIES } from './agent-script';

/** A function the agent can call during a call, independent of any voice provider. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** Short lines the agent may say while the tool runs, so the line is never silent. */
  waitingLines: string[];
}

export const CHECK_ADDRESS_TOOL: AgentToolDefinition = {
  name: 'check_address',
  description:
    'Checks a US street address the customer gave for a visit: whether it exists, its ZIP code, and whether it is in our service area. ' +
    'Call it once you have the street number, street name and city or ZIP.',
  parameters: {
    type: 'object',
    properties: {
      address: { type: 'string', description: 'The address as the customer said it, e.g. "1699 Baywood Dr, Concord, CA 94521".' },
    },
    required: ['address'],
  },
  waitingLines: ['Let me just check that address.', 'One sec, let me pull that up.'],
};

export const AGENT_TOOLS = [CHECK_ADDRESS_TOOL];

const checkAddressArgs = z.object({ address: z.string().min(3) });

export interface AddressMatch {
  matchedAddress: string;
  zip: string;
  county: string; // e.g. "Contra Costa County"
}

/** Turns a geocoder answer into an instruction the agent can act on. */
export function describeAddressCheck(heard: string, matches: AddressMatch[] | null): string {
  if (matches === null) {
    return 'The address check is unavailable right now. Read the address back to the customer to confirm it instead.';
  }
  if (matches.length === 0) {
    return (
      `No match for "${heard}". It may have been misheard. Ask the customer to repeat the street number and street name, ` +
      'and to spell the street name if it is unusual. If it still does not match after one more try, keep what they said and move on.'
    );
  }
  const [match] = matches;
  const countyName = match.county.replace(/ County$/, '');
  const inArea = SERVICE_AREA_COUNTIES.includes(countyName);
  const found = `Found: ${match.matchedAddress} (ZIP ${match.zip}, ${match.county}).`;
  if (!inArea) {
    return (
      `${found} This is outside our usual service area. Don't book it. Tell the customer the team will check whether they can ` +
      'get out there and get back to them, and record it for the team.'
    );
  }
  return `${found} Inside our service area. Read it back naturally to confirm, including the ZIP code.`;
}

const censusResponse = z.object({
  result: z.object({
    addressMatches: z.array(
      z.looseObject({
        matchedAddress: z.string(),
        addressComponents: z.looseObject({ zip: z.string() }),
        geographies: z.looseObject({ Counties: z.array(z.looseObject({ NAME: z.string() })).optional() }),
      }),
    ),
  }),
});

/** Runs the agent's mid-call tools. Every answer is a sentence for the agent; a tool never throws at the caller. */
@Injectable()
export class AgentToolsService {
  private readonly logger = new Logger(AgentToolsService.name);

  async run(name: string, args: unknown): Promise<string> {
    if (name === CHECK_ADDRESS_TOOL.name) {
      const parsed = checkAddressArgs.safeParse(args);
      if (!parsed.success) return 'Ask the customer for the full street address first, then check it.';
      return describeAddressCheck(parsed.data.address, await this.geocode(parsed.data.address));
    }
    this.logger.warn(`Agent called unknown tool ${name}`);
    return 'That tool is not available. Carry on without it.';
  }

  /** US Census geocoder: free, no key, about a second. Returns null when it cannot answer. */
  private async geocode(address: string): Promise<AddressMatch[] | null> {
    const url = new URL('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
    url.search = new URLSearchParams({
      address,
      benchmark: 'Public_AR_Current',
      vintage: 'Current_Current',
      layers: 'Counties',
      format: 'json',
    }).toString();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = censusResponse.parse(await response.json());
      return body.result.addressMatches.map((match) => ({
        matchedAddress: match.matchedAddress,
        zip: match.addressComponents.zip,
        county: match.geographies.Counties?.[0]?.NAME ?? 'unknown county',
      }));
    } catch (error) {
      this.logger.warn(`Address check failed for "${address}": ${error}`);
      return null;
    }
  }
}
