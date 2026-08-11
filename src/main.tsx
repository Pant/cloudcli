import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'
import i18n, { initializeI18n } from './i18n/config.js'
import { installConsoleCapture } from './lib/consoleCapture'
import { initializePerformanceDiagnostics } from './lib/performanceDiagnostics'
import { initializePwaRegistration } from './lib/pwaRegistration'
import './index.css'

installConsoleCapture()
initializePerformanceDiagnostics()

void initializePwaRegistration()

// Start loading the saved language before rendering, but let react-i18next
// Suspense boundaries own resource readiness instead of delaying React mount.
void initializeI18n()

const root = document.getElementById('root');
if (!root) throw new Error('Application root element was not found.');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App i18n={i18n} />
  </React.StrictMode>,
)
