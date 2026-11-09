/** Optional meeting-level preferences, never game legality or consent. */
export const TABLE_SIZE_POLICY = 'meeting-size-preferences-v1';
export const SIZE_BUCKETS = Object.freeze(['2', '3-4', '5+']);
export function normalizeSizePreferences(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return []; } }
  if (!Array.isArray(value)) return [];
  const selected = SIZE_BUCKETS.filter(k => value.includes(k));
  return selected.length === SIZE_BUCKETS.length ? [] : selected;
}
export function memberSizePreferences(member, meetingId) {
  // The private snapshot includes dated values. Looking up the current seed/date
  // means a one-meeting choice is NOT silently repeated in later dummy months.
  if (member.tableSizePreferencesByMeeting !== undefined) {
    let values = member.tableSizePreferencesByMeeting;
    if (typeof values === 'string') { try { values = JSON.parse(values); } catch { return []; } }
    return normalizeSizePreferences(values && typeof values === 'object' && !Array.isArray(values) ? values[meetingId] : []);
  }
  return normalizeSizePreferences(member.tableSizePreferences ?? member.tableSizePreferencesJson);
}
export function sizeBucket(players) {
  return players === 2 ? '2' : players === 3 || players === 4 ? '3-4' : Number.isInteger(players) && players >= 5 ? '5+' : null;
}
export function matchesSize(member, players) { return member.tableSizePreferences?.includes(sizeBucket(players)) ? 1 : 0; }

/** Exact per-game partitions, retaining the number of copies as a DP dimension.
 * A single larger table must not hide a better pair of smaller tables. Likewise,
 * a high-scoring split may not consume a copy needed by another split of this game.
 * Return null for neutral inputs so the established tie ordering is unchanged.
 */
export function sizePartitions(members, teacherForTable, populations, copiesAvailable) {
  if (!members.some(m => m.tableSizePreferences.length)) return null;
  const size = populations.length, maxCopies = Math.min(copiesAvailable, members.length);
  const match = new Uint8Array(size);
  for (let mask = 1; mask < size; mask++) {
    if (!teacherForTable[mask]) continue;
    const players = populations[mask];
    for (let i = 0; i < members.length; i++) if (mask & (1 << i)) match[mask] += matchesSize(members[i], players);
  }
  const scores = Array.from({length:maxCopies + 1}, () => new Int8Array(size).fill(-1));
  const firstByCount = Array.from({length:maxCopies + 1}, () => new Uint16Array(size));
  scores[0][0] = 0;
  const copies = new Uint8Array(size).fill(255), matches = new Uint8Array(size);
  copies[0] = 0;
  for (let mask = 1; mask < size; mask++) {
    const bit = mask & -mask;
    if (teacherForTable[mask]) { scores[1][mask] = match[mask]; firstByCount[1][mask] = mask; }
    if (maxCopies > 1) for (let subset = (mask - 1) & mask; subset; subset = (subset - 1) & mask) {
      if (!(subset & bit) || !teacherForTable[subset]) continue;
      const rest = mask ^ subset;
      for (let k = 2; k <= Math.min(maxCopies, populations[mask]); k++) {
        if (scores[k-1][rest] < 0) continue;
        const value = match[subset] + scores[k-1][rest];
        if (value > scores[k][mask] || (value === scores[k][mask] && subset < firstByCount[k][mask])) {
          scores[k][mask] = value; firstByCount[k][mask] = subset;
        }
      }
    }
    for (let k = 1; k <= maxCopies; k++) {
      if (scores[k][mask] >= 0 && (copies[mask] === 255 || scores[k][mask] > matches[mask])) {
        copies[mask] = k; matches[mask] = scores[k][mask];
      }
    }
  }
  return {copies, matches, firstByCount};
}
