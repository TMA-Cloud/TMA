import React, { ReactNode, useState } from "react";

interface TooltipProps {
  text: string;
  children: ReactNode;
}

export const Tooltip: React.FC<TooltipProps> = ({ text, children }) => {
  const [visible, setVisible] = useState(false);

  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
      tabIndex={0}
    >
      {children}
      <span
        className={`
          pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 whitespace-nowrap
          px-3 py-1 rounded-lg shadow-lg text-sm font-medium
          bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900
          transition-all duration-200 opacity-0 scale-95
          ${visible ? "opacity-100 scale-100" : ""}
        `}
        role="tooltip"
      >
        {text}
      </span>
    </span>
  );
};
