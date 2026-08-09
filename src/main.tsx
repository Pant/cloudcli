import React from 'react'
import ReactDOM from 'react-dom/client'
import type { i18n as I18nInstance } from 'i18next';

import App from './App'
import { initializeI18n } from './i18n/config.js'
import { installConsoleCapture } from './lib/consoleCapture'
import './index.css'

installConsoleCapture()

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => {
    void registration.update().catch(err => {
      console.warn('Service worker update check failed:', err);
    });
  }).catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

initializeI18n().then((i18n: I18nInstance) => {
  const root = document.getElementById('root');
  if (!root) throw new Error('Application root element was not found.');
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App i18n={i18n} />
    </React.StrictMode>,
  )
})
