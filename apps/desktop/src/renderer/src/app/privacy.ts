export function maskHostAddress(value: string): string {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) {
    const segments = value.split('.');
    return `${segments[0]}.${segments[1]}.*.*`;
  }
  if (value.includes(':')) {
    const segments = value.split(':').filter(Boolean);
    return segments.length > 2 ? `${segments.slice(0, 2).join(':')}:…` : '***';
  }
  return value.length <= 3 ? '***' : `***${value.slice(3)}`;
}
