import { describe, expect, it } from 'vitest';
import {
  isAllowedYouTubeUrl,
  sanitizeRecipeVideos,
  youtubeWatchUrl,
} from './youtube-url.js';

describe('isAllowedYouTubeUrl', () => {
  it('allows the official YouTube hosts on https', () => {
    expect(isAllowedYouTubeUrl('https://www.youtube.com/watch?v=abcdefghijk')).toBe(true);
    expect(isAllowedYouTubeUrl('https://youtube.com/watch?v=abcdefghijk')).toBe(true);
    expect(isAllowedYouTubeUrl('https://m.youtube.com/watch?v=abcdefghijk')).toBe(true);
    expect(isAllowedYouTubeUrl('https://youtu.be/abcdefghijk')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isAllowedYouTubeUrl('http://www.youtube.com/watch?v=abcdefghijk')).toBe(false);
    expect(isAllowedYouTubeUrl('https://evil.example/watch?v=abcdefghijk')).toBe(false);
    expect(isAllowedYouTubeUrl('https://www.youtube.com.evil.example/watch')).toBe(false);
    expect(isAllowedYouTubeUrl('https://user:pass@www.youtube.com/watch?v=abcdefghijk')).toBe(false);
    expect(isAllowedYouTubeUrl('https://www.youtube.com/redirect?q=https://evil.example')).toBe(
      false
    );
    expect(isAllowedYouTubeUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedYouTubeUrl('not a url')).toBe(false);
  });
});

describe('youtubeWatchUrl', () => {
  it('builds an allowlisted watch URL from a safe video id', () => {
    expect(youtubeWatchUrl('dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('rejects ids that cannot be turned into a safe URL', () => {
    expect(youtubeWatchUrl('../evil')).toBeNull();
    expect(youtubeWatchUrl('https://evil.example')).toBeNull();
    expect(youtubeWatchUrl('')).toBeNull();
  });
});

describe('sanitizeRecipeVideos', () => {
  it('drops videos with unusable ids and attaches an official URL', () => {
    const out = sanitizeRecipeVideos({
      'Whisk eggs': { videoId: 'dQw4w9WgXcQ', title: 'How to whisk', channelTitle: 'A' },
      'Bad': { videoId: 'https://evil.example/x', title: 'Nope' },
    });
    expect(out['Whisk eggs']?.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(out['Bad']).toBeUndefined();
  });
});
