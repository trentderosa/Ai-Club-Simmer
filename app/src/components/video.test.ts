import { openableYouTubeUrl } from '../domain/youtube-url';

describe('video opening policy', () => {
  it('refuses to open mock placeholders', () => {
    expect(openableYouTubeUrl({ videoId: 'mockVideo01', title: 'Placeholder' }, true)).toBeNull();
  });

  it('only opens allowlisted YouTube URLs', () => {
    expect(openableYouTubeUrl({ videoId: 'dQw4w9WgXcQ' }, false)).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
    expect(openableYouTubeUrl({ videoId: 'bad id!!' }, false)).toBeNull();
  });
});
