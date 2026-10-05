import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setThemePreference, useTheme } from './useTheme';

type ChangeListener = (event: MediaQueryListEvent) => void;

/** A controllable `window.matchMedia` so the hook can be driven in jsdom (which has none). */
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<ChangeListener>();
  let dark = initialDark;
  const mql = {
    get matches() { return dark; },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: 'change', cb: ChangeListener) => { listeners.add(cb); },
    removeEventListener: (_type: 'change', cb: ChangeListener) => { listeners.delete(cb); },
    addListener: (cb: ChangeListener) => { listeners.add(cb); },
    removeListener: (cb: ChangeListener) => { listeners.delete(cb); },
    dispatchEvent: () => true,
  };
  const matchMedia = vi.fn((query: string) => ({ ...mql, media: query, get matches() { return dark; } }));
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    listenerCount: () => listeners.size,
    setSystemDark(next: boolean) {
      dark = next;
      for (const cb of listeners) cb({ matches: next, media: mql.media } as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  act(() => setThemePreference('auto'));
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useTheme', () => {
  it('defaults to auto, resolves to light when matchMedia is unavailable and sets no attribute', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe('auto');
    expect(result.current.resolved).toBe('light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('writes data-theme on <html> for explicit choices and removes it again for auto', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(result.current.preference).toBe('dark');
    expect(result.current.resolved).toBe('dark');

    act(() => result.current.setPreference('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(result.current.resolved).toBe('light');

    act(() => result.current.setPreference('auto'));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(result.current.preference).toBe('auto');
  });

  it('follows the system scheme while auto and reacts to change events', () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(media.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(result.current.resolved).toBe('dark');
    act(() => media.setSystemDark(false));
    expect(result.current.resolved).toBe('light');
    act(() => media.setSystemDark(true));
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('an explicit preference wins over the system scheme and stops listening until auto is chosen again', () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(media.listenerCount()).toBeGreaterThan(0);

    act(() => result.current.setPreference('light'));
    expect(result.current.resolved).toBe('light');
    expect(media.listenerCount()).toBe(0);
    act(() => media.setSystemDark(false));
    act(() => media.setSystemDark(true));
    expect(result.current.resolved).toBe('light');

    act(() => result.current.setPreference('auto'));
    expect(media.listenerCount()).toBeGreaterThan(0);
    expect(result.current.resolved).toBe('dark');
  });

  it('shares a single in-memory preference across every consumer', () => {
    const first = renderHook(() => useTheme());
    const second = renderHook(() => useTheme());
    act(() => first.result.current.setPreference('dark'));
    expect(second.result.current.preference).toBe('dark');
    expect(second.result.current.resolved).toBe('dark');
  });

  it('removes its media-query listener on unmount', () => {
    const media = installMatchMedia(false);
    const { unmount } = renderHook(() => useTheme());
    expect(media.listenerCount()).toBeGreaterThan(0);
    unmount();
    expect(media.listenerCount()).toBe(0);
  });

  it('never reads or writes Web Storage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference('dark'));
    act(() => result.current.setPreference('light'));
    act(() => result.current.setPreference('auto'));
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });
});
