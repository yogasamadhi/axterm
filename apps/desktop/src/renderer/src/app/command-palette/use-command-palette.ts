import { useState } from 'react';
import {
  buildPaletteItems,
  rememberPaletteUsage,
  type PaletteInput,
  type PaletteUsage,
} from './palette-model';

export function useCommandPalette(input: PaletteInput) {
  const [usage, setUsage] = useState<PaletteUsage[]>([]);
  return {
    items: buildPaletteItems(input),
    usage,
    remember: (id: string) => setUsage((current) => rememberPaletteUsage(current, id)),
  };
}
