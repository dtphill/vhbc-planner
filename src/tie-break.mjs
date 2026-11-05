import {createHash} from 'node:crypto';

export const TIE_BREAK_METHOD = 'meeting-seeded-order-v1';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/**
 * A stable, domain-separated lottery order for a meeting. No clock, runtime
 * randomness, request counter or submitted array position affects the draw.
 * The server supplies the meeting ID; it never accepts a seed from the client.
 * This orders otherwise equal solutions; it is not uniform sampling of every
 * possible complete schedule and does not promise alternating winners.
 */
export function createMeetingTieBreak(seed) {
  if (seed == null || seed === '') return null; // Legacy standalone callers.
  if (typeof seed !== 'string' || seed.length > 128) throw new TypeError('Invalid meeting tie-break seed.');
  const ranks = new Map();
  const rank = (domain, key) => {
    const encoded = JSON.stringify([TIE_BREAK_METHOD, seed, domain, String(key)]);
    if (!ranks.has(encoded)) ranks.set(encoded, createHash('sha256').update(encoded).digest('hex'));
    return ranks.get(encoded);
  };
  return {
    compare(domain, a, b) { return compare(rank(domain, a), rank(domain, b)) || compare(a, b); },
    details: {method:TIE_BREAK_METHOD, seed},
  };
}
