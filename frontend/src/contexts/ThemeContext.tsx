import { createContext, useContext } from "react";

interface ThemeContextType {
  theme: "dark";
}

export const ThemeContext = createContext<ThemeContextType | undefined>(
  undefined,
);

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};

// Moved ThemeProvider to ./ThemeProvider.tsx to keep this file hook-only
