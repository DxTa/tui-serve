import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import App from './App';

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // vite-plugin-pwa handles registration automatically when build is used
    // In dev, we skip explicit registration
  });
}

// xterm.js schedules async DOM measurements during mount. React StrictMode's
// dev-only mount/unmount/remount cycle can dispose that renderer mid-measure,
// causing duplicate terminal setup and "dimensions" errors. Keep single mount.
createRoot(document.getElementById('root')!).render(<App />);