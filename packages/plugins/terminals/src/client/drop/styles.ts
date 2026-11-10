import styles from './drop.module.css';
export { cssText } from './drop.module.css';
export const cx = (value: string) =>
  value
    .split(/\s+/u)
    .map((name) => `${name} ${styles[name] ?? ''}`)
    .join(' ');
