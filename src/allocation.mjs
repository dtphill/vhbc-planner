/**
 * Pure, deterministic allocation of complete simultaneous board-game tables.
 *
 * Export: allocateTables({ members, games, fixedTables = [] }). IDs may be strings
 * or numbers; output IDs retain their input type. `members` is the confirmed
 * attendance roster, so an available ownership offer represents one lendable
 * copy even when its owner plays at a different table.
 *
 * Ratings must explicitly be "want" or "will". A priority must also be rated
 * "want"; a stale priority never overrides "pass" or an unanswered rating.
 * Member restrictions apply whether or not that member is the assigned teacher.
 * Teaching counts are exact, discrete choices, never a min/max interval.
 *
 * History contains completed plays, oldest first. Optional
 * `history.priorityFeasible === true` is a saved planning-time observation;
 * missing/false values earn no unmet-priority credit. Fixed plays earn no credit
 * and do not age other credit, but actually playing a priority fulfils it.
 * Four recent non-fixed plays are considered; each history bonus is capped at 2.
 * Current feasibility means at least one valid table after fixed reservations,
 * not a guarantee that it coexists with every other preferred table.
 *
 * Ranking is lexicographic: seated people, bounded priority/fairness value,
 * then current desire. A priority is worth 6; up to 2 points each recognise
 * recent accommodation and explicitly recorded unmet feasible priorities.
 * Want earns the accommodation bonus; Will does not. Desire is Want=2, Will=1.
 * Scores of fixed tables are constant and have no priority/fairness contribution.
 *
 * Exact member-mask DP processes each game once. Its local options partition
 * people into valid tables within the number of available copies. This avoids
 * an extra exponential state for combinations of consumed copy resources.
 * Automatic allocation is bounded to 12 remaining people; fixed tables may be
 * outside that pool. Invalid fixed proposals hold their named people and copy
 * until corrected, while unaffected attendees can still be allocated.
 *
 * Returns { tables, unassignedMemberIds, warnings, score,
 *           feasiblePriorityMemberIds }.
 * Equal scores use stable ID order, not input order or randomness. History has
 * no involuntary-exclusion record, so this function does not invent seat credit.
 */

const MAX_AUTOMATIC_MEMBERS = 12;
const HISTORY_WINDOW = 4;
const BONUS_CAP = 2;
const PRIORITY_VALUE = 6;
const accepted = rating => rating === 'want' || rating === 'will';
const idKey = id => (typeof id === 'string' && id.length > 0)
  || (typeof id === 'number' && Number.isFinite(id)) ? String(id) : null;
const compareKeys = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const copyKey = (gameKey, memberKey) => JSON.stringify([gameKey, memberKey]);
const exactCounts = value => Array.isArray(value)
  ? [...new Set(value.filter(count => Number.isInteger(count) && count > 0))].sort((a, b) => a - b)
  : [];

function uniqueRecords(records, label, warnings) {
  const byId = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = idKey(record?.id);
    if (key === null) {
      warnings.push(`A ${label} with an invalid ID was ignored.`);
      continue;
    }
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(record);
  }
  return [...byId.entries()].sort(([a], [b]) => compareKeys(a, b)).flatMap(([key, values]) => {
    if (values.length > 1) {
      warnings.push(`Duplicate ${label} ID ${key}; those records were ignored until corrected.`);
      return [];
    }
    return [{ ...values[0], key }];
  });
}

function accommodationBonus(member) {
  const recent = member.history.filter(play => play && !play.fixed
    && idKey(play.gameId) !== null && accepted(play.rating)).slice(-HISTORY_WINDOW);
  return Math.min(BONUS_CAP, recent.filter(play => play.rating === 'will').length);
}

function priorityWaitingBonus(member) {
  if (member.priorityKey === null) return 0;
  let opportunities = 0;
  let bonus = 0;
  for (let index = member.history.length - 1; index >= 0; index -= 1) {
    const play = member.history[index];
    if (!play || idKey(play.gameId) === null) continue;
    if (idKey(play.gameId) === member.priorityKey) break;
    if (play.fixed || !accepted(play.rating)) continue;
    // A different priority ends this request's waiting history.
    if (idKey(play.priorityGameId) !== member.priorityKey) break;
    opportunities += 1;
    if (play.priorityFeasible === true) bonus += 1;
    if (opportunities >= HISTORY_WINDOW) break;
  }
  return Math.min(BONUS_CAP, bonus);
}

function allowsCount(member, gameKey, count) {
  return !member.restrictions.has(gameKey) || member.restrictions.get(gameKey).has(count);
}

function tableReason(game, tableMembers) {
  const priority = tableMembers.filter(member => member.priorityKey === game.key);
  const want = tableMembers.filter(member => member.priorityKey !== game.key && member.ratings[game.key] === 'want');
  const will = tableMembers.filter(member => member.ratings[game.key] === 'will');
  const parts = [];
  if (priority.length) parts.push(`${priority.length} current priority ${priority.length === 1 ? 'pick' : 'picks'}`);
  if (want.length) parts.push(`${want.length} other wanted ${want.length === 1 ? 'choice' : 'choices'}`);
  if (will.length) parts.push(`${will.length} willing ${will.length === 1 ? 'assignment' : 'assignments'}`);
  const boosted = tableMembers.filter(member => member.ratings[game.key] === 'want'
    && (member.accommodation > 0 || (member.priorityKey === game.key && member.waiting > 0)));
  return `${parts.join('; ')}.${boosted.length
    ? ` Recent accommodation or unmet-priority history favours ${boosted.map(member => member.name).join(', ')}.`
    : ''}`;
}

function betterScores(fairness, desire, other) {
  return !other || fairness > other.fairness || (fairness === other.fairness && desire > other.desire);
}

export function allocateTables(input = {}) {
  const warnings = [];
  const members = uniqueRecords(input.members, 'member', warnings).map(record => ({
    ...record,
    name: typeof record.name === 'string' && record.name ? record.name : record.key,
    ratings: record.ratings && typeof record.ratings === 'object' ? record.ratings : {},
    rawRestrictions: record.restrictions,
    restrictions: new Map(),
    history: Array.isArray(record.history) ? record.history : [],
    priorityKey: idKey(record.priorityGameId),
  }));
  const memberByKey = new Map(members.map(member => [member.key, member]));
  const games = uniqueRecords(input.games, 'game', warnings).map(record => ({
    ...record,
    title: typeof record.title === 'string' && record.title ? record.title : record.key,
    offers: new Map(),
    rawOffers: Array.isArray(record.offers) ? record.offers : [],
  }));
  const gameByKey = new Map(games.map(game => [game.key, game]));

  for (const member of members) {
    if (member.rawRestrictions && typeof member.rawRestrictions === 'object') {
      for (const [gameKey, counts] of Object.entries(member.rawRestrictions)) {
        member.restrictions.set(gameKey, new Set(exactCounts(counts)));
        if (!Array.isArray(counts)) {
          warnings.push(`${member.name} has an invalid player-count restriction for ${gameByKey.get(gameKey)?.title ?? gameKey}; that game is excluded for them.`);
        }
      }
    }
    if (member.priorityKey !== null && (!gameByKey.has(member.priorityKey)
      || member.ratings[member.priorityKey] !== 'want')) {
      warnings.push(`${member.name}'s current priority was ignored because it is not an available catalogue entry rated Want.`);
      member.priorityKey = null;
    }
    member.accommodation = accommodationBonus(member);
    member.waiting = priorityWaitingBonus(member);
  }

  for (const game of games) {
    const offersByMember = new Map();
    for (const offer of game.rawOffers) {
      const key = idKey(offer?.userId);
      if (key === null || !memberByKey.has(key)) continue;
      if (!offersByMember.has(key)) offersByMember.set(key, []);
      offersByMember.get(key).push(offer);
    }
    for (const [key, offers] of [...offersByMember].sort(([a], [b]) => compareKeys(a, b))) {
      if (offers.length > 1) {
        warnings.push(`Duplicate offers from ${memberByKey.get(key).name} for ${game.title}; those offers were ignored until corrected.`);
        continue;
      }
      const offer = offers[0];
      if (offer.available === false) continue;
      game.offers.set(key, {
        userKey: key,
        own: offer.own === true,
        teach: offer.teach === true,
        counts: new Set(exactCounts(offer.counts)),
      });
    }
  }

  const proposedFixed = (Array.isArray(input.fixedTables) ? input.fixedTables : []).map((table, index) => {
    const source = table && typeof table === 'object' ? table : {};
    const gameKey = idKey(source.gameId);
    const teacherKey = idKey(source.teacherId);
    const ownerKey = idKey(source.copyOwnerId);
    const rawMembers = Array.isArray(source.memberIds) ? source.memberIds.map(idKey) : [];
    const memberKeys = [...new Set(rawMembers.filter(key => key !== null))].sort(compareKeys);
    const claims = new Set(memberKeys.filter(key => memberByKey.has(key)));
    if (memberByKey.has(teacherKey)) claims.add(teacherKey);
    return {
      key: idKey(source.id) ?? JSON.stringify([gameKey, memberKeys, teacherKey, ownerKey, index]),
      gameKey, teacherKey, ownerKey, memberKeys, claims, rawMembers,
      resource: gameKey !== null && ownerKey !== null ? copyKey(gameKey, ownerKey) : null,
      errors: [],
    };
  }).sort((a, b) => compareKeys(a.key, b.key));

  const memberClaims = new Map();
  const copyClaims = new Map();
  for (const table of proposedFixed) {
    const game = gameByKey.get(table.gameKey);
    if (!game) table.errors.push('the game is missing');
    if (!table.rawMembers.length || table.rawMembers.some(key => key === null)
      || table.rawMembers.length !== table.memberKeys.length) {
      table.errors.push('its player list is empty, invalid or duplicated');
    }
    if (table.memberKeys.some(key => !memberByKey.has(key))) table.errors.push('a named player is not attending');
    if (!table.memberKeys.includes(table.teacherKey)) table.errors.push('the teacher must be one of its players');
    const teachingOffer = game?.offers.get(table.teacherKey);
    if (!teachingOffer?.teach || !teachingOffer.counts.has(table.memberKeys.length)) {
      table.errors.push('the assigned teacher has not offered this exact player count');
    }
    if (!game?.offers.get(table.ownerKey)?.own) table.errors.push('its copy is not confirmed available from an attendee');
    for (const key of table.memberKeys) {
      const member = memberByKey.get(key);
      if (!member || !game) continue;
      if (!accepted(member.ratings[game.key])) table.errors.push(`${member.name} has not accepted this game`);
      if (!allowsCount(member, game.key, table.memberKeys.length)) {
        table.errors.push(`${member.name} has not accepted this player count`);
      }
    }
    for (const key of table.claims) {
      if (!memberClaims.has(key)) memberClaims.set(key, []);
      memberClaims.get(key).push(table);
    }
    if (table.resource !== null) {
      if (!copyClaims.has(table.resource)) copyClaims.set(table.resource, []);
      copyClaims.get(table.resource).push(table);
    }
  }
  for (const [key, tables] of memberClaims) {
    if (tables.length > 1) for (const table of tables) {
      table.errors.push(`${memberByKey.get(key).name} is also named in another pre-arranged table`);
    }
  }
  for (const tables of copyClaims.values()) {
    if (tables.length > 1) for (const table of tables) table.errors.push('the same copy is reserved by another pre-arranged table');
  }

  const heldMembers = new Set();
  const heldCopies = new Set();
  const fixedTables = [];
  const feasiblePriorityKeys = new Set();
  let fixedDesire = 0;
  for (const table of proposedFixed) {
    for (const key of table.claims) heldMembers.add(key);
    if (table.resource !== null) heldCopies.add(table.resource);
    if (table.errors.length) {
      warnings.push(`Pre-arranged table ${table.key} needs correction: ${[...new Set(table.errors)].join('; ')}. Its named players and copy are held out of automatic allocation.`);
      continue;
    }
    const game = gameByKey.get(table.gameKey);
    const tableMembers = table.memberKeys.map(key => memberByKey.get(key));
    for (const member of tableMembers) {
      fixedDesire += member.ratings[game.key] === 'want' ? 2 : 1;
      if (member.priorityKey === game.key) feasiblePriorityKeys.add(member.key);
    }
    fixedTables.push({
      gameId: game.id,
      memberIds: tableMembers.map(member => member.id),
      teacherId: memberByKey.get(table.teacherKey).id,
      copyOwnerId: memberByKey.get(table.ownerKey).id,
      fixed: true,
      reason: 'Pre-arranged table; willingness, exact player counts, teacher and copy have been checked.',
    });
  }

  const automaticMembers = members.filter(member => !heldMembers.has(member.key));
  const fixedSeated = fixedTables.reduce((count, table) => count + table.memberIds.length, 0);
  const finish = (automaticTables, automaticScore) => {
    const tables = [...fixedTables, ...automaticTables];
    const seated = new Set(tables.flatMap(table => table.memberIds.map(idKey)));
    return {
      tables,
      unassignedMemberIds: members.filter(member => !seated.has(member.key)).map(member => member.id),
      warnings: [...new Set(warnings)].sort(compareKeys),
      score: {
        seated: fixedSeated + automaticScore.seated,
        priorityAndFairness: automaticScore.fairness,
        desire: fixedDesire + automaticScore.desire,
      },
      feasiblePriorityMemberIds: members.filter(member => feasiblePriorityKeys.has(member.key)).map(member => member.id),
    };
  };
  if (automaticMembers.length > MAX_AUTOMATIC_MEMBERS) {
    warnings.push(`Automatic allocation supports at most ${MAX_AUTOMATIC_MEMBERS} people after pre-arranged tables; ${automaticMembers.length} remain. No automatic tables were guessed.`);
    return finish([], { seated: 0, fairness: 0, desire: 0 });
  }
  if (!automaticMembers.length) return finish([], { seated: 0, fairness: 0, desire: 0 });

  const count = automaticMembers.length;
  const size = 1 << count;
  const fullMask = size - 1;
  const populations = new Uint8Array(size);
  const firstIndices = new Uint8Array(size);
  for (let mask = 1; mask < size; mask += 1) {
    const bit = mask & -mask;
    populations[mask] = populations[mask ^ bit] + 1;
    firstIndices[mask] = 31 - Math.clz32(bit);
  }

  let dp = new Array(size);
  dp[0] = { fairness: 0, desire: 0, previous: null, optionMask: 0, gameOptions: null };
  for (const game of games) {
    const owners = [...game.offers.values()].filter(offer => offer.own
      && !heldCopies.has(copyKey(game.key, offer.userKey))).map(offer => offer.userKey).sort(compareKeys);
    if (!owners.length) continue;
    const teachersAtCount = new Int32Array(count + 1);
    const eligibleAtCount = new Int32Array(count + 1);
    const memberFairness = new Int16Array(count);
    const memberDesire = new Uint8Array(count);
    let eligibleMask = 0;
    for (let index = 0; index < count; index += 1) {
      const member = automaticMembers[index];
      if (!accepted(member.ratings[game.key])) continue;
      const bit = 1 << index;
      const offer = game.offers.get(member.key);
      memberDesire[index] = member.ratings[game.key] === 'want' ? 2 : 1;
      memberFairness[index] = member.ratings[game.key] === 'want' ? member.accommodation : 0;
      if (member.priorityKey === game.key) memberFairness[index] += PRIORITY_VALUE + member.waiting;
      for (let players = 1; players <= count; players += 1) {
        if (!allowsCount(member, game.key, players)) continue;
        eligibleAtCount[players] |= bit;
        if (offer?.teach && offer.counts.has(players)) teachersAtCount[players] |= bit;
      }
    }
    const teacherForTable = new Uint8Array(size); // index + 1, zero means invalid
    for (let mask = 1; mask < size; mask += 1) {
      const players = populations[mask];
      if ((mask & eligibleAtCount[players]) !== mask) continue;
      const teachers = mask & teachersAtCount[players];
      if (!teachers) continue;
      teacherForTable[mask] = firstIndices[teachers] + 1;
      eligibleMask |= mask;
      for (let bits = mask; bits; bits &= bits - 1) {
        const member = automaticMembers[firstIndices[bits]];
        if (member.priorityKey === game.key) feasiblePriorityKeys.add(member.key);
      }
    }
    if (!eligibleMask) continue;

    const tableCount = new Uint8Array(size);
    tableCount.fill(255);
    tableCount[0] = 0;
    const firstTable = new Uint16Array(size);
    const fairnessForMask = new Int16Array(size);
    const desireForMask = new Uint8Array(size);
    for (let mask = 1; mask < size; mask += 1) {
      const bit = mask & -mask;
      const index = firstIndices[mask];
      fairnessForMask[mask] = fairnessForMask[mask ^ bit] + memberFairness[index];
      desireForMask[mask] = desireForMask[mask ^ bit] + memberDesire[index];
      if ((mask & eligibleMask) !== mask) continue;
      if (teacherForTable[mask]) {
        tableCount[mask] = 1;
        firstTable[mask] = mask;
      } else if (owners.length > 1) {
        // Every partition has exactly one table containing the lowest member.
        // Considering that table first avoids duplicate permutations of tables.
        for (let subset = (mask - 1) & mask; subset; subset = (subset - 1) & mask) {
          if (!(subset & bit) || !teacherForTable[subset]) continue;
          const candidateCount = tableCount[mask ^ subset] + 1;
          if (candidateCount > owners.length || candidateCount > tableCount[mask]) continue;
          if (candidateCount < tableCount[mask] || !firstTable[mask] || subset < firstTable[mask]) {
            tableCount[mask] = candidateCount;
            firstTable[mask] = subset;
          }
        }
      }
    }
    const gameOptions = { game, owners, teacherForTable, firstTable };
    const next = dp.slice();
    for (let covered = 0; covered < size; covered += 1) {
      const previous = dp[covered];
      if (!previous) continue;
      const available = eligibleMask & (fullMask ^ covered);
      for (let subset = available; subset; subset = (subset - 1) & available) {
        if (tableCount[subset] > owners.length) continue;
        const combined = covered | subset;
        const fairness = previous.fairness + fairnessForMask[subset];
        const desire = previous.desire + desireForMask[subset];
        if (!betterScores(fairness, desire, next[combined])) continue;
        next[combined] = { fairness, desire, previous, optionMask: subset, gameOptions };
      }
    }
    dp = next;
  }

  let bestMask = 0;
  let best = dp[0];
  for (let mask = 1; mask < size; mask += 1) {
    const candidate = dp[mask];
    if (!candidate) continue;
    if (populations[mask] > populations[bestMask]
      || (populations[mask] === populations[bestMask]
        && betterScores(candidate.fairness, candidate.desire, best))) {
      bestMask = mask;
      best = candidate;
    }
  }
  const automaticTables = [];
  for (let node = best; node?.gameOptions; node = node.previous) {
    const { game, owners, teacherForTable, firstTable } = node.gameOptions;
    let remaining = node.optionMask;
    let copyIndex = 0;
    while (remaining) {
      const mask = firstTable[remaining];
      const tableMembers = automaticMembers.filter((_, index) => mask & (1 << index));
      automaticTables.push({
        gameId: game.id,
        memberIds: tableMembers.map(member => member.id),
        teacherId: automaticMembers[teacherForTable[mask] - 1].id,
        copyOwnerId: memberByKey.get(owners[copyIndex]).id,
        fixed: false,
        reason: tableReason(game, tableMembers),
      });
      copyIndex += 1;
      remaining ^= mask;
    }
  }
  automaticTables.sort((a, b) => compareKeys(idKey(a.gameId), idKey(b.gameId))
    || compareKeys(JSON.stringify(a.memberIds.map(idKey)), JSON.stringify(b.memberIds.map(idKey))));
  return finish(automaticTables, { seated: populations[bestMask], fairness: best.fairness, desire: best.desire });
}

export default allocateTables;
