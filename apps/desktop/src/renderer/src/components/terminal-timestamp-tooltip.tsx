import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { clampUnixTimestampTooltip, type TerminalPointerPosition } from './terminal-timestamp';

interface TerminalTimestampTooltipProps {
  pointer: TerminalPointerPosition;
  text: string;
}

export function TerminalTimestampTooltip({ pointer, text }: TerminalTimestampTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const bounds = tooltip.getBoundingClientRect();
    const position = clampUnixTimestampTooltip(
      pointer,
      { width: bounds.width, height: bounds.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    tooltip.style.left = `${position.left}px`;
    tooltip.style.top = `${position.top}px`;
    tooltip.style.visibility = 'visible';
  }, [pointer, text]);

  return createPortal(
    <div
      ref={tooltipRef}
      className="terminal-unix-timestamp-tooltip"
      role="tooltip"
      style={{ left: 0, top: 0, visibility: 'hidden' }}
    >
      {text}
    </div>,
    document.body,
  );
}
