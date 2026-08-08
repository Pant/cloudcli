import type { RefObject } from 'react';

type ShellMinimalViewProps = {
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  isExtraKeyboardExpanded: boolean;
};

export default function ShellMinimalView({
  terminalContainerRef,
  isExtraKeyboardExpanded,
}: ShellMinimalViewProps) {
  return (
    <div className="relative h-full w-full bg-gray-900">
      <div
        ref={terminalContainerRef}
        className={`${isExtraKeyboardExpanded ? 'h-[calc(100%-5rem)]' : 'h-full'} w-full focus:outline-none`}
        style={{ outline: 'none' }}
      />
    </div>
  );
}
