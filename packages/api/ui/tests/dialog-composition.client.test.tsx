// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Dialog, DialogClose, DialogContent, DialogTitle, Button } from '@axterm/ui/controls';
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});
for (const builtin of [false, true])
  it(`preserves feature-owned Dialog markup and focus/close composition with asChild and ${builtin ? 'a built-in' : 'an owned'} close action`, async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <Dialog defaultOpen>
          <DialogContent
            asChild
            aria-describedby={undefined}
            {...(builtin ? { closeLabel: 'Built-in close' } : {})}
          >
            <section data-feature-dialog className="owned-feature">
              <DialogTitle asChild>
                <h2>Owned title</h2>
              </DialogTitle>
              <DialogClose asChild>
                <Button>Owned close</Button>
              </DialogClose>
            </section>
          </DialogContent>
        </Dialog>,
      );
    });
    const section = document.querySelector<HTMLElement>('[data-feature-dialog]');
    expect(section?.getAttribute('role')).toBe('dialog');
    expect(section?.classList.contains('owned-feature')).toBe(true);
    expect(section?.querySelectorAll('h2')).toHaveLength(1);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const close = builtin
      ? section?.querySelector<HTMLButtonElement>('[aria-label="Built-in close"]')
      : section?.querySelector<HTMLButtonElement>('button');
    expect(close).toBeTruthy();
    await act(async () => {
      close!.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

for (const mode of ['restore', 'prevented', 'detached', 'caller-focus'] as const)
  it(`keeps the actual opener and caller focus policy for controlled action dialogs: ${mode}`, async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    function Example() {
      const [open, setOpen] = useState(false);
      const [present, setPresent] = useState(true);
      return (
        <>
          {present && (
            <button data-opener onClick={() => setOpen(true)}>
              Open by action
            </button>
          )}
          <button data-destination>Destination</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              aria-describedby={undefined}
              onCloseAutoFocus={(event) => {
                if (mode === 'prevented') event.preventDefault();
                if (mode === 'prevented' || mode === 'caller-focus')
                  document.querySelector<HTMLButtonElement>('[data-destination]')!.focus();
              }}
            >
              <DialogTitle>Action dialog</DialogTitle>
              <input aria-label="Name" autoFocus />
              {mode === 'detached' && (
                <button data-remove-opener onClick={() => setPresent(false)}>
                  Withdraw opener
                </button>
              )}
              <DialogClose asChild>
                <Button data-close-action>Close action dialog</Button>
              </DialogClose>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    await act(async () => root!.render(<Example />));
    const opener = container.querySelector<HTMLButtonElement>('[data-opener]')!;
    vi.spyOn(opener, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    await act(async () => {
      opener.focus();
      opener.click();
    });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Name');
    if (mode === 'detached')
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-remove-opener]')!.click(),
      );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[role=dialog] [data-close-action]')!.click(),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.querySelector('[role=dialog]')).toBeNull();
    if (mode === 'restore') expect(document.activeElement).toBe(opener);
    else if (mode === 'detached') expect(document.activeElement).not.toBe(opener);
    else expect(document.activeElement).toBe(container.querySelector('[data-destination]'));
  });
