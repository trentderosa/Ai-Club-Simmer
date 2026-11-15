import { isAllowedYouTubeUrl, openableYouTubeUrl, youtubeWatchUrl } from './youtube-url';

describe('youtube URLs', () => {
  it('allows only official YouTube https hosts', () => {
    expect(isAllowedYouTubeUrl('https://www.youtube.com/watch?v=abcdefghijk')).toBe(true);
    expect(isAllowedYouTubeUrl('https://youtu.be/abcdefghijk')).toBe(true);
    expect(isAllowedYouTubeUrl('https://evil.example/watch?v=abcdefghijk')).toBe(false);
    expect(isAllowedYouTubeUrl('http://www.youtube.com/watch?v=abcdefghijk')).toBe(false);
  });

  it('does not open placeholder (mock) videos, even if the id looks like a YouTube id', () => {
    expect(openableYouTubeUrl({ videoId: 'dQw4w9WgXcQ' }, true)).toBeNull();
    expect(openableYouTubeUrl({ videoId: 'dQw4w9WgXcQ' }, false)).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
  });

  it('rejects a non-YouTube url even if one is supplied', () => {
    expect(openableYouTubeUrl({ videoId: 'dQw4w9WgXcQ', url: 'https://evil.example/x' }, false)).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
    expect(youtubeWatchUrl('../evil')).toBeNull();
  });
});
