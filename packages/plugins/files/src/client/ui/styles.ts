import styles, { cssText } from './files.module.css';
export { cssText };
export const cx = (value: string | undefined) =>
  (value ?? '')
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => `${name} ${styles[name] ?? ''}`)
    .join(' ');
