import type { RouteObject } from 'react-router-dom';

import AppContent from './components/app/AppContent';

export const appRoutes: RouteObject[] = [
  {
    path: '/',
    element: <AppContent />,
    children: [
      { index: true, element: <></> },
      { path: 'session/:sessionId', element: <></> },
    ],
  },
];
