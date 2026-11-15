/** Hosts the app will open for a technique video. Anything else is not openable. */
export const ALLOWED_YOUTUBE_HOSTS = [
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
] as const;

const ALLOWED_HOST_SET = new Set<string>(ALLOWED_YOUTUBE_HOSTS);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

export function isAllowedYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (url.username !== '' || url.password !== '') return false;
    if (!ALLOWED_HOST_SET.has(url.hostname.toLowerCase())) return false;
    const path = url.pathname.toLowerCase();
    if (path.includes('/redirect') || path.includes('/attribution_link')) return false;
    return true;
  } catch {
    return false;
  }
}

export function youtubeWatchUrl(videoId: string): string | null {
  if (!VIDEO_ID_RE.test(videoId)) return null;
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return isAllowedYouTubeUrl(url) ? url : null;
}

/** The URL to open for a video card, or null if it must not be opened. */
export function openableYouTubeUrl(video: { videoId: string; url?: string; title?: string }, placeholder: boolean): string | null {
  if (placeholder) return null;
  if (video.url && isAllowedYouTubeUrl(video.url)) return video.url;
  return youtubeWatchUrl(video.videoId);
}
