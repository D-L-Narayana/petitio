import { useSyncExternalStore } from 'react';

/**
 * Colour-theme preference, kept in memory only (PLAN §2.1: no Web Storage, no cookies).
 * `auto` follows the operating system via `prefers-color-scheme`; `light`/`dark` pin the palette by
 * writing `data-theme` on `<html>`, which src/theme/tokens.css reads. Refreshing the page resets it.
 */
export type ThemePreference = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeHandle {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

export const THEME_PREFERENCES: readonly ThemePreference[] = ['auto', 'light', 'dark'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

// Module-level store so every consumer (toggle, any future reader) sees one preference.
let preference: ThemePreference = 'auto';
const listeners = new Set<() => void>();

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function applyAttribute(next: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (next === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', next);
}

export function getThemePreference(): ThemePreference {
  return preference;
}

/** Sets the in-memory preference and mirrors it onto `<html data-theme>`; unknown values are ignored. */
export function setThemePreference(next: ThemePreference): void {
  if (!isThemePreference(next)) return;
  const changed = next !== preference;
  preference = next;
  applyAttribute(next);
  if (changed) for (const notify of listeners) notify();
}

function subscribePreference(notify: () => void): () => void {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

/** Listens to the OS scheme; only used while the preference is `auto`. */
function subscribeSystem(notify: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', notify);
  return () => { query.removeEventListener('change', notify); };
}

function subscribeNothing(): () => void {
  return () => {};
}

function getSystemScheme(): ResolvedTheme {
  return hasMatchMedia() && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function getServerScheme(): ResolvedTheme {
  return 'light';
}

export function useTheme(): ThemeHandle {
  const current = useSyncExternalStore(subscribePreference, getThemePreference, getThemePreference);
  const system = useSyncExternalStore(current === 'auto' ? subscribeSystem : subscribeNothing, getSystemScheme, getServerScheme);
  return {
    preference: current,
    resolved: current === 'auto' ? system : current,
    setPreference: setThemePreference,
  };
}
