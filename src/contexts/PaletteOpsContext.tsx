import { useRef } from 'react';
import type { ReactNode } from 'react';

import { PaletteOpsContext } from './paletteOps';
import type { PaletteOps } from './paletteOps';

export type { PaletteOps } from './paletteOps';

export function PaletteOpsProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Partial<PaletteOps>>({});
  return <PaletteOpsContext.Provider value={ref}>{children}</PaletteOpsContext.Provider>;
}
