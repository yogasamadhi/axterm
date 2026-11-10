import styles from './tools.module.css';
export const cx = (...names: string[]) =>
  names
    .flatMap((value) =>
      value
        .split(/\s+/)
        .filter(Boolean)
        .map((name) => name + ' ' + (styles[name] ?? '')),
    )
    .join(' ');
