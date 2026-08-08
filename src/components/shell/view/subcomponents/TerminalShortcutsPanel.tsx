import { type MutableRefObject, useCallback } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, Clipboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Terminal } from '@xterm/xterm';

import {
  getShortcutSequence,
  MOBILE_TERMINAL_SHORTCUTS,
  type MobileTerminalModifier,
  type MobileTerminalModifiers,
} from '../../utils/terminalShortcutKeys';
import { sendSocketMessage } from '../../utils/socket';

type Props = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  isConnected: boolean;
  mobileModifiers: MobileTerminalModifiers;
  onToggleModifier: (modifier: MobileTerminalModifier) => void;
  onClearModifiers: () => void;
  isExpanded: boolean;
  onExpandedChange: (isExpanded: boolean) => void;
  bottomOffset?: string;
};

const preventFocusSteal = (event: React.PointerEvent) => event.preventDefault();
const KEY_BTN = 'shrink-0 rounded-md border border-gray-600 bg-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-100 transition-colors select-none active:border-blue-600 active:bg-blue-600 active:text-white disabled:cursor-not-allowed disabled:opacity-40';
const ACTIVE_BTN = 'shrink-0 rounded-md border border-blue-500 bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors select-none disabled:cursor-not-allowed disabled:opacity-40';
const ICON_BTN = 'shrink-0 rounded-md border border-gray-600 bg-gray-700 p-1.5 text-gray-100 transition-colors select-none active:border-blue-600 active:bg-blue-600 active:text-white disabled:cursor-not-allowed disabled:opacity-40';
const DIRECTION_ICONS: Record<string, typeof ArrowUp> = {
  up: ArrowUp,
  down: ArrowDown,
  left: ArrowLeft,
  right: ArrowRight,
};

export default function TerminalShortcutsPanel({
  wsRef, terminalRef, isConnected, mobileModifiers, onToggleModifier, onClearModifiers,
  isExpanded, onExpandedChange,
  bottomOffset = 'bottom-0',
}: Props) {
  const { t } = useTranslation('settings');
  const sendInput = useCallback((data: string) => {
    sendSocketMessage(wsRef.current, { type: 'input', data });
  }, [wsRef]);

  const paste = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
    } catch { /* Clipboard permission was denied. */ }
  }, [sendInput]);

  return (
    <div className={`pointer-events-none fixed inset-x-0 ${bottomOffset} z-20 px-2`}>
      {isExpanded ? <div className="pointer-events-auto grid grid-flow-col grid-rows-2 items-center gap-1 overflow-x-auto rounded-lg border border-gray-700/80 bg-gray-900/95 px-1.5 py-1.5 shadow-lg backdrop-blur-sm [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button type="button" onPointerDown={preventFocusSteal} onClick={() => onExpandedChange(false)}
          className={KEY_BTN} title="Hide extra keyboard" aria-label="Hide extra keyboard" aria-expanded={isExpanded}>
          Hide
        </button>
        <button type="button" onPointerDown={preventFocusSteal} onClick={() => void paste()}
          disabled={!isConnected} className={ICON_BTN} title="Paste" aria-label="Paste">
          <Clipboard className="h-4 w-4" />
        </button>
        {MOBILE_TERMINAL_SHORTCUTS.map((shortcut) => {
          if (shortcut.type === 'modifier') {
            return <button type="button" key={shortcut.id} onPointerDown={preventFocusSteal}
              onClick={() => onToggleModifier(shortcut.id)} disabled={!isConnected}
              className={mobileModifiers[shortcut.id] ? ACTIVE_BTN : KEY_BTN}
              title={shortcut.ariaLabel} aria-label={shortcut.ariaLabel} aria-pressed={mobileModifiers[shortcut.id]}>
              {shortcut.label}
            </button>;
          }
          const label = shortcut.ariaLabel ?? shortcut.label;
          const DirectionIcon = DIRECTION_ICONS[shortcut.id];
          return <button type="button" key={shortcut.id} onPointerDown={preventFocusSteal}
            onClick={() => {
              const result = getShortcutSequence(shortcut, mobileModifiers);
              sendInput(result.data);
              if (result.consumed) onClearModifiers();
            }} disabled={!isConnected} className={KEY_BTN} title={label} aria-label={label}>
            {DirectionIcon ? <DirectionIcon className="h-4 w-4" aria-hidden="true" /> : shortcut.label}
          </button>;
        })}
        <button type="button" onPointerDown={preventFocusSteal}
          onClick={() => terminalRef.current?.scrollToBottom()} disabled={!isConnected} className={ICON_BTN}
          title={t('terminalShortcuts.scrollDown', { defaultValue: 'Scroll to bottom' })}
          aria-label={t('terminalShortcuts.scrollDown', { defaultValue: 'Scroll to bottom' })}>
          <ArrowDownToLine className="h-4 w-4" />
        </button>
      </div> : <div className="flex justify-end">
        <button type="button" onPointerDown={preventFocusSteal} onClick={() => onExpandedChange(true)}
          className={`${KEY_BTN} pointer-events-auto border-gray-700/80 bg-gray-900/95 shadow-lg backdrop-blur-sm`}
          title="Show extra keyboard" aria-label="Show extra keyboard" aria-expanded={isExpanded}>
          Show
        </button>
      </div>}
    </div>
  );
}
