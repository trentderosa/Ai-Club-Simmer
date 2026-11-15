/** Hosts the client is allowed to open for a technique video. */
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

export function isYouTubeVideoId(videoId: string): boolean {
  return VIDEO_ID_RE.test(videoId);
}

/** Official watch URL, or null if the id isn’t a safe YouTube video id. */
export function youtubeWatchUrl(videoId: string): string | null {
  if (!isYouTubeVideoId(videoId)) return null;
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return isAllowedYouTubeUrl(url) ? url : null;
}

export interface TechniqueVideoWithUrl {
  videoId: string;
  title?: string;
  channelTitle?: string;
  url?: string;
}

/**
 * Keep only videos whose id can be turned into an allowlisted YouTube URL,
 * and attach that URL. Used before saving or returning cook-anything videos.
 */
export function sanitizeRecipeVideos(
  videos: Record<string, { videoId: string; title?: string; channelTitle?: string }>
): Record<string, TechniqueVideoWithUrl> {
  const out: Record<string, TechniqueVideoWithUrl> = {};
  for (const [technique, video] of Object.entries(videos)) {
    const url = youtubeWatchUrl(video.videoId);
    if (!url) continue;
    out[technique] = {
      videoId: video.videoId,
      ...(video.title ? { title: video.title } : {}),
      ...(video.channelTitle ? { channelTitle: video.channelTitle } : {}),
      url,
    };
  }
  return out;
}
