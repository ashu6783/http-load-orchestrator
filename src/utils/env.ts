export function envInt(name: string, fallback: number): number {
    const v = process.env[name];
    if (v == null || v === '') return fallback;
    const n = parseInt(v, 10);
    return Number.isNaN(n) || n < 1 ? fallback : n;
  }
  