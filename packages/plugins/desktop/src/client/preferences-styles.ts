import styles from './preferences.module.css';
export { cssText } from './preferences.module.css';
export const cx = (value: string) =>
  value
    .split(/\s+/u)
    .map((name) => `${name} ${styles[name] ?? ''}`)
    .join(' ');
