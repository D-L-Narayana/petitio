import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from './ThemeToggle';
import { setThemePreference, useTheme } from './useTheme';

/** Renders what any other consumer of useTheme sees, so the toggle's effect is observed from outside. */
function Probe() {
  const { preference, resolved } = useTheme();
  return <output data-testid="probe">{`${preference}/${resolved}`}</output>;
}

function radio(name: string): HTMLInputElement | null {
  return screen.queryByRole('radio', { name }) as HTMLInputElement | null;
}

afterEach(() => {
  act(() => setThemePreference('auto'));
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ThemeToggle', () => {
  it('is a radiogroup named "Colour theme" with Auto, Light and Dark radios, Auto checked by default', () => {
    render(<ThemeToggle />);
    const group = screen.queryByRole('radiogroup', { name: 'Colour theme' });
    expect(group).not.toBeNull();
    const radios = screen.queryAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(['auto', 'light', 'dark']);
    expect(radios.map((r) => r.labels?.[0]?.textContent?.trim())).toEqual(['Auto', 'Light', 'Dark']);
    expect(radio('Auto')?.checked).toBe(true);
    expect(radio('Light')?.checked).toBe(false);
    expect(radio('Dark')?.checked).toBe(false);
  });

  it('switching to Dark changes the resolved theme for other consumers and sets data-theme', async () => {
    const user = userEvent.setup();
    render(<><ThemeToggle /><Probe /></>);
    expect(screen.getByTestId('probe')).toHaveTextContent('auto/light');

    const dark = radio('Dark');
    expect(dark).not.toBeNull();
    await user.click(dark!);
    expect(radio('Dark')?.checked).toBe(true);
    expect(screen.getByTestId('probe')).toHaveTextContent('dark/dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    const auto = radio('Auto');
    await user.click(auto!);
    expect(screen.getByTestId('probe')).toHaveTextContent('auto/light');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('is keyboard operable: arrow keys move the selection inside the group', async () => {
    const user = userEvent.setup();
    render(<><ThemeToggle /><Probe /></>);
    const auto = radio('Auto');
    expect(auto).not.toBeNull();
    act(() => auto!.focus());
    await user.keyboard('{ArrowRight}');
    expect(radio('Light')?.checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByTestId('probe')).toHaveTextContent('light/light');

    await user.keyboard('{ArrowRight}');
    expect(radio('Dark')?.checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(radio('Auto')?.checked).toBe(true);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('reflects a preference chosen elsewhere', () => {
    render(<ThemeToggle />);
    act(() => setThemePreference('light'));
    expect(radio('Light')?.checked).toBe(true);
    expect(radio('Auto')?.checked).toBe(false);
  });

  it('never touches Web Storage (Storage.prototype spies stay uncalled)', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const dark = radio('Dark');
    const auto = radio('Auto');
    if (dark) await user.click(dark);
    if (auto) await user.click(auto);
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });
});
