export function terminalPreviewControlOrigin(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('DASHBOARD_PREVIEW_CONTROL_ORIGIN must be an HTTPS origin with no credentials, path, query, or fragment'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value !== url.origin) {
    throw new Error('DASHBOARD_PREVIEW_CONTROL_ORIGIN must be an HTTPS origin with no credentials, path, query, or fragment');
  }
  return url.origin;
}
