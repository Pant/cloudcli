import { createContext, useContext } from 'react';

import type { TaskMasterContextValue } from '../types';

const TaskMasterContext = createContext<TaskMasterContextValue | null>(null);

export function useTaskMaster(): TaskMasterContextValue {
  const context = useContext(TaskMasterContext);
  if (!context) {
    throw new Error('useTaskMaster must be used within a TaskMasterProvider');
  }
  return context;
}

export default TaskMasterContext;
