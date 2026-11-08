/** Shared live/simulation policy. Only recorded plays supplied to the solver count. */
export const ROTATION_POLICY = 'personal-history-rotation-v1';
export const PRIORITY_REST_PLAYS = 4;
export const ROTATION_HISTORY_LIMIT = 24;
const key = value => ((typeof value === 'string' && value.length > 0)
  || (typeof value === 'number' && Number.isFinite(value))) ? String(value) : null;
const accepted = value => value === 'want' || value === 'will';
const validHistory = member => (Array.isArray(member.history) ? member.history : [])
  .filter(play => play && key(play.gameId) !== null && accepted(play.rating))
  .slice(-ROTATION_HISTORY_LIMIT);

/** 25 for absent from retained history; otherwise count attended plays since last play (0–23).
 * This is per player, not a group-wide ban. Reserved plays count as plays here.
 */
export function rotationPoints(member, gameId) {
  const id = key(gameId);
  if (id === null) return 0;
  const history = validHistory(member);
  for (let i = history.length - 1; i >= 0; i--) {
    if (key(history[i].gameId) === id) return history.length - 1 - i;
  }
  return ROTATION_HISTORY_LIMIT + 1;
}

/** A played pick stays selected, but its base/waiting boost rests for four other plays.
 * Accommodation is unchanged. Waiting never accrues for the plays while a pick rests.
 */
export function allocationBonuses(member, priorityId = member.priorityGameId) {
  const history = validHistory(member);
  const priority = key(priorityId);
  const active = priority !== null && member.ratings?.[priority] === 'want';
  const accommodation = Math.min(2, history.filter(p => !p.fixed).slice(-4)
    .filter(p => p.rating === 'will').length);
  let lastPlayed = -1;
  if (active) for (let i = history.length - 1; i >= 0; i--) {
    if (key(history[i].gameId) === priority) { lastPlayed = i; break; }
  }
  const priorityRest = !active || lastPlayed < 0 ? 0
    : Math.max(0, PRIORITY_REST_PLAYS - (history.length - 1 - lastPlayed));
  let opportunities = 0, waiting = 0;
  if (active && priorityRest === 0) for (let i = history.length - 1; i >= 0; i--) {
    const play = history[i];
    if (key(play.gameId) === priority) break;
    if (play.fixed) continue;
    if (key(play.priorityGameId) !== priority) break;
    opportunities++;
    // Before this historical play, four other attended plays must already have elapsed.
    const rested = lastPlayed < 0 || i - lastPlayed - 1 >= PRIORITY_REST_PLAYS;
    if (rested && play.priorityFeasible === true) waiting++;
    if (opportunities >= 4) break;
  }
  waiting = Math.min(2, waiting);
  const priorityBase = active && priorityRest === 0 ? 6 : 0;
  return {accommodation, waiting, priorityBase, priorityRest,
    priorityValue: active ? priorityBase + waiting + accommodation : 0};
}
