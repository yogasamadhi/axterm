import styles, { cssText } from './transfer.module.css';
export { cssText };
export const transferCx = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => `${name} ${styles[name] ?? ''}`)
    .join(' ');
