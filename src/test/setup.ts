/**
 * Vitest setup (vite.config.ts → test.setupFiles). Adds jest-dom matchers, unmounts React trees after
 * each test and fills the gaps in jsdom that the UI relies on. Every stub is installed only when the
 * environment lacks the API, so engine-only files may opt into `// @vitest-environment node`.
 *
 * Downloads: src/ui/download.ts creates an object URL and clicks an `<a download>`. jsdom would try to
 * navigate ("Not implemented: navigation to another Document"), so clicking a download anchor is
 * intercepted and recorded on `globalThis.__petitioDownloads` (filename, href and the Blob behind the
 * URL) for assertions. The array is emptied after every test.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

export interface RecordedDownload {
  filename: string;
  href: string;
  /** The Blob passed to URL.createObjectURL, when the download went through an object URL. */
  blob?: Blob;
}

declare global {
  var __petitioDownloads: RecordedDownload[] | undefined;
}

globalThis.__petitioDownloads = [];

afterEach(() => {
  cleanup();
  if (globalThis.__petitioDownloads) globalThis.__petitioDownloads.length = 0;
});

const blobsByUrl = new Map<string, Blob>();

if (typeof URL !== 'undefined') {
  const nativeCreate = URL.createObjectURL as ((obj: Blob | MediaSource) => string) | undefined;
  const nativeRevoke = URL.revokeObjectURL as ((url: string) => void) | undefined;
  // Stub when missing; otherwise wrap, so the Blob behind each URL can be recovered for assertions.
  URL.createObjectURL = (obj: Blob | MediaSource): string => {
    const url = typeof nativeCreate === 'function' ? nativeCreate.call(URL, obj) : 'blob:petitio-test';
    if (obj instanceof Blob) blobsByUrl.set(url, obj);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => {
    blobsByUrl.delete(url);
    if (typeof nativeRevoke === 'function') nativeRevoke.call(URL, url);
  };
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  const minimalMediaQueryList = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: minimalMediaQueryList });
}

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: () => undefined });
}

if (typeof HTMLAnchorElement !== 'undefined') {
  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
    if (this.hasAttribute('download')) {
      const href = this.href;
      const blob = blobsByUrl.get(href) ?? blobsByUrl.get(this.getAttribute('href') ?? '');
      globalThis.__petitioDownloads?.push({ filename: this.getAttribute('download') ?? '', href, ...(blob ? { blob } : {}) });
      return;
    }
    nativeClick.call(this);
  };
}
