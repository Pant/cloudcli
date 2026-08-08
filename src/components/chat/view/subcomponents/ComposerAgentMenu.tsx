import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { ProviderAgentOption } from '../../../../types/app';
import { useComposerMenuAnchor } from '../../hooks/useComposerMenuAnchor';

import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSurface,
} from './ComposerMenuPrimitives';

type ComposerAgentMenuProps = {
  agent: string;
  agentOptions: ProviderAgentOption[];
  agentsLoading: boolean;
  onSelectAgent: (agent: string) => void;
  onOpen: () => void;
};

export default function ComposerAgentMenu({
  agent,
  agentOptions,
  agentsLoading,
  onSelectAgent,
  onOpen,
}: ComposerAgentMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);
  const selectedOption = useMemo(
    () => agentOptions.find((option) => option.value === agent),
    [agent, agentOptions],
  );
  const ariaLabel = t('composer.agentMenu', {
    defaultValue: 'Select OpenCode agent',
  });

  if (agentOptions.length === 0 && !agentsLoading) {
    return null;
  }

  const triggerLabel = selectedOption?.label
    || agent
    || t('composer.loadingAgents', { defaultValue: 'Loading agents…' });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          if (!isOpen) {
            onOpen();
          }
          setIsOpen(!isOpen);
        }}
        className="flex h-8 max-w-20 shrink-0 items-center rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-40"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="truncate">{triggerLabel}</span>
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          <ComposerMenuHeading>
            {t('composer.agent', { defaultValue: 'Agent' })}
          </ComposerMenuHeading>
          {agentsLoading && agentOptions.length === 0 && (
            <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
              {t('composer.loadingAgents', { defaultValue: 'Loading agents…' })}
            </p>
          )}
          {agentOptions.map((option) => (
            <ComposerMenuItem
              key={option.value}
              label={option.label}
              description={option.description}
              isSelected={option.value === agent}
              onSelect={() => {
                onSelectAgent(option.value);
                setIsOpen(false);
              }}
            />
          ))}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}
