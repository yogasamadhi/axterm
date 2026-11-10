import styles, { cssText } from './tools.module.css';
export { cssText };
export const cx = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
