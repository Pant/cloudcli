export function isCommandPaletteShortcut(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key'>) {
  return (event.metaKey || event.ctrlKey)
    && !event.shiftKey
    && !event.altKey
    && event.key.toLowerCase() === 'k';
}
