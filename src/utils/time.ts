export function nowCompact(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}
