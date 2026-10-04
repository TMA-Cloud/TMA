import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LucideProvider } from 'lucide-react';
import App from './App.tsx';
import { ICON_STROKE } from './components/ui/iconStroke';
import './index.css';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LucideProvider strokeWidth={ICON_STROKE}>
      <App />
    </LucideProvider>
  </StrictMode>
);
