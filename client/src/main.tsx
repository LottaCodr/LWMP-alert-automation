import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './app/App.js';
import { SessionProvider } from './app/session.js';
import { ToastProvider } from './components/Toasts.js';
import { applyTheme } from './hooks/useTheme.js';

const container = document.getElementById('root');
if (!container) throw new Error('The #root element is missing from index.html.');

// Apply the saved colour scheme before the first paint to avoid a flash of the
// wrong theme on reload.
applyTheme(
  (() => {
    try {
      const stored = window.localStorage.getItem('lwmp.theme');
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      return 'system';
    }
  })(),
);

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ToastProvider>
  </StrictMode>,
);
