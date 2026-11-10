import styles from './ui.module.css';
/** Retain the product class vocabulary and add scoped CSS Module identities. */
export const cx = (...names: (string | undefined)[]): string =>
  names
    .filter(Boolean)
    .join(' ')
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => `${name} ${styles[name] ?? ''}`)
    .join(' ');
