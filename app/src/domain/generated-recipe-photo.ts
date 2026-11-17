/**
 * Hero photo for a Cook anything recipe. A Commons image from the server is
 * used when the URL is on upload.wikimedia.org; otherwise we fall back to
 * the generic cutting-board photo. Credit links open only the Commons file page.
 */
import type { DishPhoto } from '../api/schemas';
import { cookAnythingPhoto } from './slot-photos';

export const COMMONS_UPLOAD_HOST = 'upload.wikimedia.org';
export const COMMONS_FILE_HOST = 'commons.wikimedia.org';

const RASTER = new Set(['jpg', 'jpeg', 'png', 'webp']);

function httpsHost(value: string, host: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    if (url.hostname.toLowerCase() !== host) return null;
    return url;
  } catch {
    return null;
  }
}

export function isDisplayableDishPhotoUrl(value: string): boolean {
  const url = httpsHost(value, COMMONS_UPLOAD_HOST);
  if (!url) return false;
  const base = url.pathname.toLowerCase().split('/').pop() ?? '';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return RASTER.has(ext);
}

export function openableCommonsSourceUrl(value: string): string | null {
  const url = httpsHost(value, COMMONS_FILE_HOST);
  if (!url) return null;
  const path = url.pathname;
  if (path.includes('/wiki/Special:Redirect') || path.toLowerCase().includes('/redirect')) return null;
  if (!(path.startsWith('/wiki/File:') || path.startsWith('/wiki/File%3A'))) return null;
  return url.toString();
}

export type GeneratedHeroPhoto =
  | { kind: 'remote'; source: { uri: string }; credit: string; sourceUrl: string | null }
  | { kind: 'fallback'; source: number; credit: string; sourceUrl: null };

export function creditLine(author: string, license: string): string {
  return `Photo: ${author} · ${license}`;
}

export function heroPhotoForGenerated(photo: DishPhoto | null | undefined): GeneratedHeroPhoto {
  if (photo && isDisplayableDishPhotoUrl(photo.url)) {
    return {
      kind: 'remote',
      source: { uri: photo.url },
      credit: creditLine(photo.credit.author, photo.credit.license),
      sourceUrl: openableCommonsSourceUrl(photo.credit.sourceUrl),
    };
  }
  return {
    kind: 'fallback',
    source: cookAnythingPhoto.source,
    credit: cookAnythingPhoto.credit,
    sourceUrl: null,
  };
}
