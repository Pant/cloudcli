import { useContext } from 'react';

import TasksSettingsContext from './tasksSettingsContext';

export const useTasksSettings = () => {
  const context = useContext(TasksSettingsContext);
  if (!context) {
    throw new Error('useTasksSettings must be used within a TasksSettingsProvider');
  }
  return context;
};
