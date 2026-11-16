import { useState } from 'react';
import type { PiCatalogProvider } from '@axterm/plugin-api/ai';
import { useI18n } from './i18n.tsx';

/** A catalog is a complete choice list; browser datalist filtering must not hide Pi models. */
export function PiModelPicker({ models }: { models: PiCatalogProvider['models'] }) {
  const { x } = useI18n();
  const [chosen, setChosen] = useState<string>();
  const model =
    chosen === '' ? '' : (models.find(({ id }) => id === chosen)?.id ?? models[0]?.id ?? '');
  return (
    <>
      <label>
        {x('panels.model')}
        <select
          name={model ? 'model' : undefined}
          value={model}
          onChange={(event) => setChosen(event.currentTarget.value)}
        >
          {models.map(({ id, name }) => (
            <option key={id} value={id}>
              {name && name !== id ? `${name} (${id})` : id}
            </option>
          ))}
          <option value="">{x('ai.customModel')}</option>
        </select>
      </label>
      {!model && (
        <label>
          {x('ai.customModel')}
          <input name="model" autoComplete="off" required />
        </label>
      )}
    </>
  );
}
