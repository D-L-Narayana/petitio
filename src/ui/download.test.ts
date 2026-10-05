import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { downloadHtml, downloadText, safeFilename } from './download';

describe('safeFilename', () => {
  it.each([
    ['../../etc/passwd', 'etc-passwd'],
    ['REQ 2026/0411', 'REQ-2026-0411'],
    ['REQ-2026-0398', 'REQ-2026-0398'],
    ['a\u0000b\u001fc\u007fd.json', 'abcd.json'],
    ['"quoted" \'name\' `tick`', 'quoted-name-tick'],
    ['..\\..\\windows\\system32', 'windows-system32'],
    ['a<b>c:d|e?f*g', 'a-b-c-d-e-f-g'],
    ['  spaced   out \t name  ', 'spaced-out-name'],
    ['.hidden', 'hidden'],
    ['...', 'export'],
    ['', 'export'],
    ['   ', 'export'],
  ])('sanitises %j to %j', (input, expected) => {
    expect(safeFilename(input)).toBe(expected);
  });

  it('caps the result at 80 characters and does not end on a separator', () => {
    const long = 'x'.repeat(100);
    expect(safeFilename(long)).toBe('x'.repeat(80));
    expect(safeFilename(`${'a'.repeat(79)}-b`)).toBe('a'.repeat(79));
  });
});

describe('download helpers', () => {
  let createObjectURL: MockInstance<typeof URL.createObjectURL>;
  let revokeObjectURL: MockInstance<typeof URL.revokeObjectURL>;
  let click: MockInstance<HTMLAnchorElement['click']>;

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:petitio-test');
    revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('downloadText wraps the text in a typed blob, clicks a temporary anchor and revokes the URL after the timeout', async () => {
    downloadText('petitio-casefile-2026-10-01.json', '{"schema":"petitio.casefile"}');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/json');
    await expect(blob.text()).resolves.toBe('{"schema":"petitio.casefile"}');
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('petitio-casefile-2026-10-01.json');
    expect(anchor.href).toBe('blob:petitio-test');
    expect(anchor.rel).toBe('noopener');
    expect(anchor.isConnected).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:petitio-test');
  });

  it('downloadHtml uses the text/html type and the same create → click → revoke sequence', async () => {
    downloadHtml('REQ-2026-0398-response-packet.html', '<!DOCTYPE html><title>x</title>');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('text/html');
    await expect(blob.text()).resolves.toBe('<!DOCTYPE html><title>x</title>');
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('REQ-2026-0398-response-packet.html');
    expect(anchor.href).toBe('blob:petitio-test');
    expect(anchor.isConnected).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:petitio-test');
  });
});
