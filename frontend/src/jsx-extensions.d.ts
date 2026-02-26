import type React from 'react';

declare module 'react' {
  interface InputHTMLAttributes<T = React.HTMLAttributes<T>> {
    /** Enable folder selection in Chromium-based browsers (non-standard). */
    webkitdirectory?: string;
    /** Enable folder selection in some browsers (non-standard). */
    directory?: string;
  }
}
