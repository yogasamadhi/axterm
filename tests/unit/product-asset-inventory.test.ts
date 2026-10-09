import { describe, expect, it } from 'vitest';
import {
  productAssetInventoryFromContents,
  serializeProductAssetInventory,
} from '../../scripts/commercialization/generate-product-asset-inventory.mjs';

const assetPaths = [
  'apps/desktop/build/icon.svg',
  'apps/desktop/build/icon.png',
  'apps/desktop/build/icon-512.png',
  'apps/desktop/build/icon.ico',
  'apps/desktop/build/icon.icns',
] as const;

function fixtureContents() {
  return new Map(assetPaths.map((path, index) => [path, Buffer.from(`asset-${index}`)]));
}

describe('product asset inventory', () => {
  it('records every declared first-party mark deterministically without claiming rights clearance', () => {
    const inventory = productAssetInventoryFromContents(fixtureContents());

    expect(inventory.assets.map(({ path }) => path)).toEqual(assetPaths);
    expect(inventory.assets.map(({ bytes }) => bytes)).toEqual([7, 7, 7, 7, 7]);
    expect(inventory.assets[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(serializeProductAssetInventory(inventory)).toContain(
      'Matching bytes do not prove authorship',
    );
    expect(serializeProductAssetInventory(inventory)).toContain('application-mark files');
  });

  it('fails closed when a listed source asset is missing', () => {
    const contents = fixtureContents();
    contents.delete('apps/desktop/build/icon.ico');
    expect(() => productAssetInventoryFromContents(contents)).toThrow(
      'Missing product asset: apps/desktop/build/icon.ico',
    );
  });
});
