import { useContext } from 'react';

import PermissionContext from './PermissionContext';
import type { PermissionContextValue } from './PermissionContext';

export function usePermission(): PermissionContextValue | null {
  return useContext(PermissionContext);
}
