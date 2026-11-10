/** A one-shot user selection, without browser persistence or a retained byte array. */
export function chooseBrowserFile(signal: AbortSignal): Promise<File | undefined> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    let settled = false;
    const finish = (file?: File, error?: unknown) => {
      if (settled) return;
      settled = true;
      input.removeEventListener('change', changed);
      input.removeEventListener('cancel', cancelled);
      signal.removeEventListener('abort', aborted);
      input.remove();
      if (error) reject(error);
      else resolve(file);
    };
    const changed = () => finish(input.files?.[0]);
    const cancelled = () => finish();
    const aborted = () => finish(undefined, new Error('CATALOG_IMPORT_SELECTION_CANCELLED'));
    input.addEventListener('change', changed, { once: true });
    input.addEventListener('cancel', cancelled, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
    document.body.append(input);
    if (signal.aborted) {
      aborted();
      return;
    }
    try {
      input.click();
    } catch (error) {
      finish(undefined, error);
    }
  });
}
