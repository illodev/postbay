/**
 * Which approved versions the studio may put into which free slot by itself (rules.auto_fill_slots, services/scheduling.ts). A slot is
 * an account at a weekly time, and says nothing of what goes there; so what may go is what that account's network takes as it is:
 *
 * - **Stories never.** A story is placed by a person: a feed slot is not a story's place.
 * - **The variant's format must suit the network**, the way the connectors pick a kind of post (the table below): a PDF document only on
 *   LinkedIn; a 16:9 video not on Instagram (vertical first) nor TikTok; YouTube only videos; a carousel wherever several pictures go.
 * - **Never on a network whose posts need a setting a person chooses each time** (TikTok's who can see it, Pinterest's board): a post
 *   put there with none would be refused. Those are scheduled by people.
 *
 * Which account, which day and which piece go first are decided in services/scheduling.ts (fillFreeSlots).
 */
const FORMATS: Record<string, readonly string[]> = {
  instagram: ['9:16', '4:5', '1:1', 'carousel'],
  facebook: ['9:16', '4:5', '1:1', '16:9', 'carousel'],
  threads: ['9:16', '4:5', '1:1', '16:9', 'carousel'],
  x: ['9:16', '4:5', '1:1', '16:9', 'carousel'],
  bluesky: ['9:16', '4:5', '1:1', '16:9', 'carousel'],
  linkedin: ['9:16', '4:5', '1:1', '16:9', 'carousel', 'document'],
  youtube: ['16:9', '9:16', '1:1'],
  tiktok: ['9:16', 'carousel'],
  pinterest: ['9:16', '4:5', '1:1', 'carousel'],
};

/** Networks whose posts need a setting a person chooses each time: the studio never fills their slots by itself. */
export const NEEDS_SETTINGS: ReadonlySet<string> = new Set(['tiktok', 'pinterest']);

export function slotFits(network: string, pieceKind: string, format: string): boolean {
  if (pieceKind === 'story' || NEEDS_SETTINGS.has(network)) return false;
  if (network === 'youtube' && pieceKind !== 'video') return false;
  return (FORMATS[network] ?? []).includes(format);
}
