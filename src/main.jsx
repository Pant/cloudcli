import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App.tsx'
import { initializeI18n } from './i18n/config.js'
import './index.css'

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

initializeI18n().then((i18n) => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App i18n={i18n} />
    </React.StrictMode>,
  )
})
