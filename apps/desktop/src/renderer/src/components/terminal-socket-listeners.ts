interface TerminalSocketHandlers {
  message(event: MessageEvent): void;
  open(): void;
  close(): void;
}

/** Owns this attachment's listeners; a queued event cannot reach a retired owner. */
export function bindTerminalSocketListeners(
  socket: EventTarget,
  handlers: TerminalSocketHandlers,
): () => void {
  let disposed = false;
  const message = (event: Event) => {
    if (!disposed) handlers.message(event as MessageEvent);
  };
  const open = () => {
    if (!disposed) handlers.open();
  };
  const close = () => {
    if (disposed) return;
    dispose();
    handlers.close();
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    socket.removeEventListener('message', message);
    socket.removeEventListener('open', open);
    socket.removeEventListener('close', close);
  }
  socket.addEventListener('message', message);
  socket.addEventListener('open', open);
  socket.addEventListener('close', close);
  return dispose;
}
