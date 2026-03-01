import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

export const ThemeToggle: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="p-2.5 rounded-2xl text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-700/50 focus:outline-none focus:ring-2 focus:ring-[#5b8def]/40 focus:ring-offset-2 focus:ring-offset-transparent dark:focus:ring-offset-slate-900 transition-all duration-300 ease-out"
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Light mode' : 'Dark mode'}
    >
      {isDark ? (
        <Sun className="w-5 h-5 transition-transform duration-300 ease-out hover:rotate-12" />
      ) : (
        <Moon className="w-5 h-5 transition-transform duration-300 ease-out hover:-rotate-12" />
      )}
    </button>
  );
};
