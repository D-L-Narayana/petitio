import { describe, expect, it } from 'vitest';
import { checkIntegrity } from './integrity';
import type { CaseFile, Hold, RightsRequest, Stage } from './types';
import demo from '../fixtures/demo-casefile.json';

/** Deep copy of the bundled fixture, typed as the engine sees it after import. */
const file = (): CaseFile => JSON.parse(JSON.stringify(demo)) as CaseFile;

function pick(f: CaseFile, id: string): { r: RightsRequest; path: string } {
  const i = f.requests.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`fixture has no ${id}`);
  return { r: f.requests[i]!, path: `casefile.requests[${i}]` };
}

const errors = (f: CaseFile) => checkIntegrity(f).filter((i) => i.level === 'error');
const warnings = (f: CaseFile) => checkIntegrity(f).filter((i) => i.level === 'warning');
const hold = (over: Partial<Hold> = {}): Hold => ({ id: 'HOLD-T-1', systemId: 'crm', reason: 'legal-hold', note: 'synthetic justification', appliedAt: '2026-09-21T10:00:00Z', ...over });

describe('checkIntegrity on the bundled fixture', () => {
  it('reports no issues at all for the demo case file', () => {
    expect(checkIntegrity(file())).toEqual([]);
  });

  it('reports nothing for an empty case file and never throws', () => {
    expect(checkIntegrity({ schema: 'petitio.casefile', version: 1, asOf: '2026-10-01', systems: [], requests: [] })).toEqual([]);
  });
});

describe('integrity errors', () => {
  it('closedOn is present if and only if the stage is closed', () => {
    const open = file();
    const a = pick(open, 'REQ-2026-0411'); // stage collecting
    a.r.closedOn = '2026-09-20';
    const e1 = errors(open);
    expect(e1).toHaveLength(1);
    expect(e1[0]).toMatchObject({ level: 'error', path: `${a.path}.closedOn` });
    expect(e1[0]!.message).toContain('REQ-2026-0411');
    expect(e1[0]!.message).toContain('closedOn');

    const closed = file();
    const b = pick(closed, 'REQ-2026-0380'); // stage closed
    delete b.r.closedOn;
    const e2 = errors(closed);
    expect(e2).toHaveLength(1);
    expect(e2[0]).toMatchObject({ level: 'error', path: `${b.path}.closedOn` });
    expect(e2[0]!.message).toContain('REQ-2026-0380');
  });

  it('rejectReason is present if and only if the stage is rejected', () => {
    const open = file();
    const a = pick(open, 'REQ-2026-0411');
    a.r.rejectReason = 'duplicate';
    const e1 = errors(open);
    expect(e1).toHaveLength(1);
    expect(e1[0]).toMatchObject({ level: 'error', path: `${a.path}.rejectReason` });
    expect(e1[0]!.message).toContain('rejectReason');

    const rejected = file();
    const b = pick(rejected, 'REQ-2026-0390'); // stage rejected
    delete b.r.rejectReason;
    const e2 = errors(rejected);
    expect(e2).toHaveLength(1);
    expect(e2[0]).toMatchObject({ level: 'error', path: `${b.path}.rejectReason` });
  });

  it('the last history entry must lead to the current stage; an empty history is fine', () => {
    const f = file();
    const { r, path } = pick(f, 'REQ-2026-0411'); // history ends in collecting, identity passed
    r.stage = 'review';
    const e = errors(f);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ level: 'error', path: `${path}.history[${r.history.length - 1}].to` });
    expect(e[0]!.message).toContain('"review"');

    const g = file();
    pick(g, 'REQ-2026-0415').r.stage = 'identity-check'; // no history at all
    expect(errors(g)).toEqual([]);
  });

  it('identity.attempts may equal but not exceed identity.maxAttempts', () => {
    const f = file();
    const { r, path } = pick(f, 'REQ-2026-0411');
    r.identity.attempts = 4; // maxAttempts is 3
    const e = errors(f);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ level: 'error', path: `${path}.identity.attempts` });
    expect(e[0]!.message).toMatch(/4/);

    const g = file();
    pick(g, 'REQ-2026-0411').r.identity.attempts = 3;
    expect(errors(g)).toEqual([]);
  });

  it('stages from collecting onwards require a passed identity check; earlier and rejected stages do not', () => {
    for (const stage of ['collecting', 'review', 'response-ready', 'closed'] as Stage[]) {
      const f = file();
      const { r, path } = pick(f, 'REQ-2026-0380'); // closed, passed, history ends in closed
      r.stage = stage;
      r.identity.status = 'failed';
      r.history[r.history.length - 1]!.to = stage; // keep the other rules satisfied so only this one fires
      if (stage !== 'closed') delete r.closedOn;
      expect(errors(f).map((i) => i.path), stage).toEqual([`${path}.identity.status`]);
    }
    for (const stage of ['received', 'identity-check', 'verified', 'rejected'] as Stage[]) {
      const f = file();
      const { r } = pick(f, 'REQ-2026-0415'); // received, identity not started, no history
      r.stage = stage;
      if (stage === 'rejected') r.rejectReason = 'out-of-scope';
      expect(errors(f), stage).toEqual([]);
    }
  });

  it('every hold must reference one of the systems of record', () => {
    const f = file();
    const { r, path } = pick(f, 'REQ-2026-0398');
    r.holds[0]!.systemId = 'warehouse';
    const e = errors(f);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ level: 'error', path: `${path}.holds[0].systemId` });
    expect(e[0]!.message).toContain('HOLD-0398-1');
    expect(e[0]!.message).toContain('"warehouse"');
  });

  it('hold ids must be unique within a request', () => {
    const f = file();
    const { r, path } = pick(f, 'REQ-2026-0398');
    r.holds.push(hold({ id: 'HOLD-0398-1', systemId: 'crm' }));
    const e = errors(f);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ level: 'error', path: `${path}.holds[1].id` });
    expect(e[0]!.message).toContain('HOLD-0398-1');

    const g = file();
    pick(g, 'REQ-2026-0398').r.holds.push(hold({ id: 'HOLD-0398-2', systemId: 'crm' }));
    expect(checkIntegrity(g)).toEqual([]);
  });
});

describe('integrity warnings', () => {
  it('a result for a system that is not in the case file is a warning with the historic wording', () => {
    const f = file();
    const { r, path } = pick(f, 'REQ-2026-0411');
    r.systemResults[0]!.systemId = 'warehouse';
    expect(checkIntegrity(f)).toEqual([
      { level: 'warning', path: `${path}.systemResults[0].systemId`, message: 'REQ-2026-0411: result for unknown system "warehouse"' },
    ]);
  });

  it('a request received after the as-of date is a warning, not an error', () => {
    const f = file();
    const { r, path } = pick(f, 'REQ-2026-0411');
    r.receivedOn = '2026-12-01'; // asOf is 2026-10-01
    expect(errors(f)).toEqual([]);
    const w = warnings(f);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'warning', path: `${path}.receivedOn` });
    expect(w[0]!.message).toContain('2026-12-01');
    expect(w[0]!.message).toContain('2026-10-01');
  });

  it('history timestamps must not go backwards; equal timestamps are fine', () => {
    const f = file();
    const { r, path } = pick(f, 'REQ-2026-0411');
    r.history[1]!.at = '2026-09-07T23:59:00Z'; // before history[0] at 2026-09-08T08:30:00Z
    expect(errors(f)).toEqual([]);
    expect(warnings(f).map((i) => i.path)).toEqual([`${path}.history[1].at`]);

    const g = file();
    const h = pick(g, 'REQ-2026-0411');
    h.r.history[1]!.at = h.r.history[0]!.at;
    expect(checkIntegrity(g)).toEqual([]);
  });

  it('two active holds on one system are a warning; a released hold does not count', () => {
    const f = file();
    const { r, path } = pick(f, 'REQ-2026-0398'); // one active hold on billing
    r.holds.push(hold({ id: 'HOLD-0398-2', systemId: 'billing' }));
    expect(errors(f)).toEqual([]);
    const w = warnings(f);
    expect(w.map((i) => i.path)).toEqual([`${path}.holds[1].systemId`]);
    expect(w[0]!.message).toContain('"billing"');

    const g = file();
    const h = pick(g, 'REQ-2026-0398');
    h.r.holds[0]!.releasedAt = '2026-09-21T09:00:00Z';
    h.r.holds.push(hold({ id: 'HOLD-0398-2', systemId: 'billing' }));
    expect(checkIntegrity(g)).toEqual([]);
  });

  it('a closedOn before receivedOn is a warning on an otherwise consistent closed request', () => {
    const f = file();
    const { r, path } = pick(f, 'REQ-2026-0380'); // received 2026-08-10
    r.closedOn = '2026-08-01';
    expect(errors(f)).toEqual([]);
    const w = warnings(f);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'warning', path: `${path}.closedOn` });
    expect(w[0]!.message).toContain('2026-08-01');
    expect(w[0]!.message).toContain('2026-08-10');
  });
});
