import type { DishPhoto } from '../api/schemas';
import { cookAnythingPhoto } from './slot-photos';
import {
  creditLine,
  heroPhotoForGenerated,
  isDisplayableDishPhotoUrl,
  openableCommonsSourceUrl,
} from './generated-recipe-photo';

const photo: DishPhoto = {
  url: 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Example.jpg',
  credit: {
    author: 'Jane Cook',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
  },
};

describe('heroPhotoForGenerated', () => {
  it('uses the dish photo and credit when the URL is a Commons raster', () => {
    expect(heroPhotoForGenerated(photo)).toEqual({
      kind: 'remote',
      source: { uri: photo.url },
      credit: 'Photo: Jane Cook · CC BY-SA 4.0',
      sourceUrl: photo.credit.sourceUrl,
    });
    expect(creditLine(photo.credit.author, photo.credit.license)).toBe('Photo: Jane Cook · CC BY-SA 4.0');
  });

  it('falls back to board.jpg when the photo is missing', () => {
    expect(heroPhotoForGenerated(null)).toEqual({
      kind: 'fallback',
      source: cookAnythingPhoto.source,
      credit: cookAnythingPhoto.credit,
      sourceUrl: null,
    });
  });

  it('falls back when the image URL is not on upload.wikimedia.org', () => {
    const bad: DishPhoto = {
      ...photo,
      url: 'https://evil.example/photo.jpg',
    };
    expect(heroPhotoForGenerated(bad).kind).toBe('fallback');
    expect(isDisplayableDishPhotoUrl(bad.url)).toBe(false);
  });

  it('does not make a credit tappable when the source URL is not a Commons file page', () => {
    expect(openableCommonsSourceUrl('https://example.com/File:Example.jpg')).toBeNull();
    expect(openableCommonsSourceUrl(photo.credit.sourceUrl)).toBe(photo.credit.sourceUrl);
  });
});
