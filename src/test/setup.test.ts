/**
 * Smoke tests for the jsdom stubs in src/test/setup.ts. Deliberately independent of the React tree so
 * they stay green while other workers' UI files are mid-change; the render helpers in helpers.tsx are
 * exercised by the UI journeys. Red-first against the committed five-line setup.ts
 * (workers/W09/red-setup-stubs.log), green with the stubs (green-setup-stubs.log).
 */
import { describe, expect, it } from 'vitest';
import { downloadText } from '../ui/download';

function recorded() {
  return globalThis.__petitioDownloads ?? [];
}

describe('jsdom stubs (src/test/setup.ts)', () => {
  it('intercepts clicks on <a download> and records filename, href and the Blob behind the object URL', async () => {
    const blob = new Blob(['{"hello":"desk"}'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'probe.json';
    document.body.appendChild(a);
    expect(() => a.click()).not.toThrow();
    a.remove();
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]).toMatchObject({ filename: 'probe.json', href: url });
    expect(recorded()[0]?.href).toMatch(/^blob:/);
    await expect(recorded()[0]?.blob?.text()).resolves.toBe('{"hello":"desk"}');
    URL.revokeObjectURL(url);
  });

  it('records downloadText() from src/ui/download.ts, the sink every export button uses', async () => {
    downloadText('petitio-probe.json', '{"schema":"petitio.casefile"}');
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]?.filename).toBe('petitio-probe.json');
    expect(recorded()[0]?.blob?.type).toBe('application/json');
    await expect(recorded()[0]?.blob?.text()).resolves.toBe('{"schema":"petitio.casefile"}');
  });

  it('empties the recorded downloads after each test', () => {
    expect(recorded()).toEqual([]);
  });

  it('leaves ordinary anchors alone: a click without a download attribute still dispatches and records nothing', () => {
    const a = document.createElement('a');
    a.href = '#top';
    let clicks = 0;
    a.addEventListener('click', (event) => {
      clicks += 1;
      event.preventDefault();
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    expect(clicks).toBe(1);
    expect(recorded()).toEqual([]);
  });

  it('provides window.matchMedia (matches: false, listeners are no-ops) and Element.prototype.scrollIntoView', () => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    expect(query.matches).toBe(false);
    expect(query.media).toBe('(prefers-color-scheme: dark)');
    expect(() => {
      query.addEventListener('change', () => undefined);
      query.removeEventListener('change', () => undefined);
      query.addListener(() => undefined);
      query.removeListener(() => undefined);
    }).not.toThrow();
    expect(() => document.body.scrollIntoView()).not.toThrow();
  });
});
