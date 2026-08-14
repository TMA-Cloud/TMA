import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

/**
 * Both icons occupy the same spot and trade places by rotating through each
 * other, so the control reads as one thing changing state rather than two
 * icons swapping. The outgoing glyph leaves along the path the incoming one
 * arrives on.
 */
export const ThemeToggle: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  const glyph =
    'absolute inset-0 grid place-items-center transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="pressable relative grid place-items-center w-9 h-9 rounded-full text-[var(--label-secondary)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--label)]"
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-pressed={isDark}
      title={isDark ? 'Light mode' : 'Dark mode'}
    >
      <span className={`${glyph} ${isDark ? 'opacity-100 rotate-0' : 'opacity-0 -rotate-90'}`} aria-hidden="true">
        <Sun className="w-[18px] h-[18px]" strokeWidth={2} />
      </span>
      <span className={`${glyph} ${isDark ? 'opacity-0 rotate-90' : 'opacity-100 rotate-0'}`} aria-hidden="true">
        <Moon className="w-[18px] h-[18px]" strokeWidth={2} />
      </span>
    </button>
  );
};
