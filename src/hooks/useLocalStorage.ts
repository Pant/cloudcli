import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Custom hook to persist state in localStorage.
 *
 * @param {string} key The key to use for localStorage.
 * @param {any} initialValue The initial value to use if nothing is in localStorage.
 * @returns {[any, Function]} A tuple containing the stored value and a setter function.
 */
function useLocalStorage<T>(key: string, initialValue: T): [T, Dispatch<SetStateAction<T>>] {
  const [storedValue, setStoredValue] = useState(() => {
    if (typeof window === 'undefined') {
      return initialValue;
    }
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.log(error);
      return initialValue;
    }
  });

  const setValue: Dispatch<SetStateAction<T>> = (value) => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const valueToStore =
        typeof value === 'function' ? (value as (previous: T) => T)(storedValue) : value;
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
      setStoredValue(valueToStore);
    } catch (error) {
      console.log(error);
    }
  };

  return [storedValue, setValue];
}

export default useLocalStorage;
