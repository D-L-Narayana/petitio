import { useId } from 'react';
import { THEME_PREFERENCES, useTheme, type ThemePreference } from './useTheme';

const LABELS: Record<ThemePreference, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' };

/**
 * Colour-theme chooser for the masthead toolbar. Real radio inputs keep native keyboard semantics
 * (Tab reaches the checked option, arrow keys move within the group); the inputs are visually hidden
 * and the labels carry the `.btn`-like look via `.theme-toggle*` classes in src/styles.css.
 * The preference is in memory only — see useTheme.
 */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const name = useId();
  return (
    <fieldset className="theme-toggle" role="radiogroup" aria-label="Colour theme">
      {THEME_PREFERENCES.map((value) => (
        <label key={value} className="theme-toggle-option">
          <input
            type="radio"
            className="theme-toggle-input"
            name={name}
            value={value}
            checked={preference === value}
            onChange={() => setPreference(value)}
          />
          <span className="theme-toggle-label">{LABELS[value]}</span>
        </label>
      ))}
    </fieldset>
  );
}
