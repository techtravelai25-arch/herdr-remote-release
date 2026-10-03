const apkPath = '/v1/app-update/apk';
const apkType = 'application/vnd.android.package-archive';
const utcDay = clock => new Date(clock).toISOString().slice(0, 10);
const daysAgo = (clock, days) => utcDay(clock - days * 86400000);

/** Count APK responses served, not completed transfers. A successful request counts once, including ranges. */
export async function recordAndroidDownload(env, response, request, clock = Date.now()) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== apkPath || url.search ||
      ![200, 206].includes(response.status) || !response.body ||
      response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== apkType ||
      response.headers.get('content-length') === '0') return false;
  await env.DB.prepare(`INSERT INTO android_download_daily(day, download_count) VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET download_count = download_count + 1`).bind(utcDay(clock)).run();
  return true;
}

/** Keep the current UTC day and the preceding 89 days. */
export async function cleanupDownloadMetrics(env, clock = Date.now()) {
  await env.DB.prepare('DELETE FROM android_download_daily WHERE day < ?').bind(daysAgo(clock, 89)).run();
}
