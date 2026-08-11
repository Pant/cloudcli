import { authenticatedFetch } from '../../utils/api';

export const initializeDocsUiSession = () => authenticatedFetch('/api/docs-ui/session', { method: 'POST' });
