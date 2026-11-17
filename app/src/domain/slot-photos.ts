/**
 * Photo per path slot (CC0, see assets/photos/CREDITS.md). Real recipes don't
 * have photos yet, so these are dish illustrations, keyed by slot order.
 */
export interface SlotPhoto {
  /** Local asset module id (what `require` of an image returns). */
  source: number;
  credit: string;
}

const PHOTOS: Record<number, SlotPhoto> = {
  1: { source: require('../../assets/photos/salad.jpg'), credit: 'Photo: fireskystudios.com, CC0' },
  2: { source: require('../../assets/photos/eggs-bowl.jpg'), credit: 'Photo: Cory Seward, CC0' },
  3: { source: require('../../assets/photos/pasta.jpg'), credit: 'Photo: Eaters Collective, CC0' },
  4: { source: require('../../assets/photos/stirfry.jpg'), credit: 'Photo: Clem Onojeghuo, CC0' },
  5: { source: require('../../assets/photos/grilledcheese.jpg'), credit: 'Photo: Photos of Japan, CC0' },
  6: { source: require('../../assets/photos/rice.jpg'), credit: 'Photo: Kawin Harasai, CC0' },
  7: { source: require('../../assets/photos/sheetpan.jpg'), credit: 'Photo: Ivan Timov, CC0' },
  8: { source: require('../../assets/photos/chicken-seared.jpg'), credit: 'Photo: NeONBRAND, CC0' },
  9: { source: require('../../assets/photos/soup.jpg'), credit: 'Photo: Cala, CC0' },
  10: { source: require('../../assets/photos/roastchicken.jpg'), credit: 'Photo: Andy Li, CC0' },
};

export const placeholderVideoThumb: number = require('../../assets/photos/board.jpg');

export function photoForSlot(slotOrder: number): SlotPhoto | null {
  return PHOTOS[slotOrder] ?? null;
}

/** Generic kitchen photo used when a Cook anything recipe has no dish photo. */
export const cookAnythingPhoto: SlotPhoto = {
  source: require('../../assets/photos/board.jpg'),
  credit: 'Photo: Webvilla, CC0',
};
