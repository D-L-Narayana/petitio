/**
 * Hostile case-file samples as string builders. Each one targets a specific importer bound or rule;
 * `HOSTILE_SAMPLES` lists the ones `parseCaseFile` must refuse (ok:false, never a throw) together with
 * the pattern the error list must mention. All content is synthetic.
 */
import type { CaseFile } from '../../engine/types';
import { DEFAULT_LIMITS, serializeCaseFile } from '../../engine/casefile';
import { makeCaseFile, makeRequest } from './build';

function serialize(file: CaseFile): string {
  return serializeCaseFile(file);
}

export function notJson(): string {
  return '{not json';
}

export function wrongSchema(): string {
  return JSON.stringify({ ...makeCaseFile(), schema: 'nope' });
}

/** Thousands of nested arrays that fit easily inside the byte limit; a recursive checker would overflow. */
export function deeplyNested(depth = 20_000): string {
  const deep = '['.repeat(depth) + ']'.repeat(depth);
  return `{"schema":"petitio.casefile","version":1,"asOf":"2026-10-01","systems":[{"id":"crm","name":"CRM (synthetic)","description":""}],"requests":[],"extra":${deep}}`;
}

/** A request id one character longer than the string limit. */
export function oversizedString(length = DEFAULT_LIMITS.maxStringLength + 1): string {
  return serialize(makeCaseFile({ requests: [makeRequest({ id: 'R'.repeat(length) })] }));
}

/** A whole file above the byte limit; must be refused before JSON.parse runs. */
export function oversizedFile(bytes = DEFAULT_LIMITS.maxBytes + 1): string {
  return 'x'.repeat(bytes);
}

export function wrongEnums(): string {
  const file = makeCaseFile({ requests: [makeRequest()] });
  const request = file.requests[0] as unknown as Record<string, unknown>;
  request['stage'] = 'teleported';
  request['jurisdiction'] = 'MARS';
  request['type'] = 'telepathy';
  (request['identity'] as Record<string, unknown>)['method'] = 'psychic';
  return JSON.stringify(file);
}

export function duplicateIds(): string {
  return serialize(makeCaseFile({ requests: [makeRequest({ id: 'REQ-2026-9100' }), makeRequest({ id: 'REQ-2026-9100', receivedOn: '2026-09-11' })] }));
}

export function tooManyRequests(count = DEFAULT_LIMITS.maxRequests + 1): string {
  return serialize(makeCaseFile({ requests: Array.from({ length: count }, (_, i) => makeRequest({ id: `REQ-2026-${String(9000 + i)}` })) }));
}

/** Valid file carrying prototype-pollution style keys; the importer must drop them without touching Object.prototype. */
export function protoKeys(): string {
  return `{"schema":"petitio.casefile","version":1,"asOf":"2026-10-01","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"systems":[{"id":"crm","name":"CRM (synthetic)","description":"","__proto__":{"polluted":true}}],"requests":[]}`;
}

export interface HostileSample {
  name: string;
  text: () => string;
  /** The joined error list must match this. */
  expect: RegExp;
}

export const HOSTILE_SAMPLES: readonly HostileSample[] = [
  { name: 'text that is not JSON', text: notJson, expect: /JSON/ },
  { name: 'the wrong schema marker', text: wrongSchema, expect: /schema/ },
  { name: '20,000 nested arrays inside the byte limit', text: deeplyNested, expect: /nesting/i },
  { name: `a ${DEFAULT_LIMITS.maxStringLength + 1}-character request id`, text: oversizedString, expect: /exceeds 4000 characters/ },
  { name: `a ${DEFAULT_LIMITS.maxBytes + 1}-byte file`, text: oversizedFile, expect: /bytes/ },
  { name: 'unknown enum values for stage, jurisdiction, type and identity method', text: wrongEnums, expect: /not an allowed value/ },
  { name: 'two requests with the same id', text: duplicateIds, expect: /duplicate/i },
  { name: `${DEFAULT_LIMITS.maxRequests + 1} requests`, text: tooManyRequests, expect: /limit is 500/ },
];
