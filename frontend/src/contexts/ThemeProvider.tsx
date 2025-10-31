import React, { useEffect } from "react";
import { ThemeContext } from "./ThemeContext";

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  useEffect(() => {
    const htmlElement = document.documentElement;
    htmlElement.classList.add("dark");
    htmlElement.style.colorScheme = "dark";
  }, []);

  return (
    <ThemeContext.Provider value={{ theme: "dark" }}>
      {children}
    </ThemeContext.Provider>
  );
};
