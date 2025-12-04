import { useEffect, useState } from "react";

// Viewport hook: treat all "responsive / tablet / mobile" widths as mobile UI.
// Anything up to and including 1024px wide will use the dedicated mobile shell.
export const useIsMobile = () => {
  const getIsMobile = () =>
    typeof window !== "undefined" ? window.innerWidth <= 1024 : false;

  const [isMobile, setIsMobile] = useState(getIsMobile);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(getIsMobile());
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return isMobile;
};
