import test from 'node:test';
import assert from 'node:assert/strict';
import allocateTables from '../src/allocation.mjs';

const member = (id, ratings, extra = {}) => ({ id, name: id, ratings, history: [], ...extra });
const offer = (userId, counts, extra = {}) => ({ userId, own: true, teach: true, counts, ...extra });
const game = (id, offers) => ({ id, title: id, offers });
const fulfilled = (gameId, extra = {}) => ({ gameId, rating: 'want', priorityGameId: null, fixed: false, ...extra });

function assertLegal(input, result) {
  const members = new Map(input.members.map(value => [value.id, value]));
  const games = new Map(input.games.map(value => [value.id, value]));
  const seated = new Set();
  const copies = new Set();
  for (const table of result.tables) {
    const selected = games.get(table.gameId);
    const teacher = selected.offers.find(value => value.userId === table.teacherId);
    const owner = selected.offers.find(value => value.userId === table.copyOwnerId);
    assert.ok(table.memberIds.includes(table.teacherId));
    assert.ok(teacher.teach && teacher.available !== false && teacher.counts.includes(table.memberIds.length));
    assert.ok(owner.own && owner.available !== false && members.has(owner.userId));
    const resource = JSON.stringify([table.gameId, table.copyOwnerId]);
    assert.ok(!copies.has(resource), 'A copy cannot be used twice');
    copies.add(resource);
    for (const id of table.memberIds) {
      const player = members.get(id);
      assert.ok(!seated.has(id), 'A member cannot play twice');
      assert.ok(['want', 'will'].includes(player.ratings[table.gameId]));
      if (Object.hasOwn(player.restrictions ?? {}, table.gameId)) {
        assert.ok(player.restrictions[table.gameId].includes(table.memberIds.length));
      }
      seated.add(id);
    }
  }
  assert.equal(result.score.seated, seated.size);
  assert.deepEqual(new Set([...seated, ...result.unassignedMemberIds]), new Set(members.keys()));
}

test('chooses actual whole tables and recognises people who recently accommodated others', () => {
  const history = [fulfilled('old', { rating: 'will' }), fulfilled('old', { rating: 'will' })];
  const input = {
    members: [
      member('A', { coin: 'want', successors: 'will', friedrich: 'pass' }),
      member('B', { coin: 'want', successors: 'will', friedrich: 'pass' }),
      member('C', { coin: 'will', successors: 'want', friedrich: 'pass' }),
      member('D', { coin: 'will', successors: 'pass', friedrich: 'pass' }),
      member('E', { coin: 'pass', successors: 'want', friedrich: 'will' }, { history }),
      member('F', { coin: 'will', successors: 'pass', friedrich: 'want' }),
      member('G', { coin: 'want', successors: 'pass', friedrich: 'want' }),
      member('H', { coin: 'want', successors: 'pass', friedrich: 'will' }, { history }),
    ],
    games: [
      game('coin', [offer('D', [], { teach: false }), offer('C', [4], { own: false }), offer('G', [4], { own: false })]),
      game('successors', [offer('A', [4])]),
      game('friedrich', [offer('F', [4])]),
    ],
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.deepEqual(result.tables.map(table => [table.gameId, table.memberIds]), [
    ['coin', ['D', 'F', 'G', 'H']],
    ['successors', ['A', 'B', 'C', 'E']],
  ]);
  assert.equal(result.score.priorityAndFairness, 4);
});

test('seating everyone outranks a smaller table that fulfils more priorities', () => {
  const input = {
    members: ['A', 'B', 'C', 'D', 'E', 'F'].map((id, index) => member(id, {
      favourite: index < 4 ? 'want' : 'pass',
      left: index < 3 ? 'will' : 'pass',
      right: index >= 3 ? 'will' : 'pass',
    }, { priorityGameId: index < 4 ? 'favourite' : null })),
    games: [game('favourite', [offer('A', [4])]), game('left', [offer('B', [3])]), game('right', [offer('E', [3])])],
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.equal(result.score.seated, 6);
  assert.deepEqual(result.tables.map(table => table.gameId), ['left', 'right']);
  assert.deepEqual(result.feasiblePriorityMemberIds, ['A', 'B', 'C', 'D']);
});

test('explicit 2 and 4 teaching choices never imply 3 players', () => {
  const input = {
    members: ['A', 'B', 'C'].map(id => member(id, { g: 'want' })),
    games: [game('g', [offer('A', [2, 4])])],
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.equal(result.score.seated, 2);
  assert.equal(result.tables[0].memberIds.length, 2);
});

test('another teacher never bypasses a member’s own player-count restrictions', () => {
  const input = {
    members: ['A', 'B', 'C', 'D'].map(id => member(id, { g: 'want' }, id === 'A' ? { restrictions: { g: [2] } } : {})),
    games: [game('g', [offer('A', [2]), offer('B', [4], { own: false })])],
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.equal(result.score.seated, 2);
  assert.equal(result.tables[0].teacherId, 'A');
});

test('different teachers and two distinct copies can support 2 and 4 player tables of the same game', () => {
  const input = {
    members: ['A', 'B', 'C', 'D', 'E', 'F'].map(id => member(id, { g: 'want' }, {
      restrictions: id === 'A' ? { g: [2] } : id === 'B' ? { g: [4] } : {},
    })),
    games: [game('g', [offer('A', [2]), offer('B', [4])])],
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.equal(result.score.seated, 6);
  assert.deepEqual(result.tables.map(table => table.memberIds.length).sort(), [2, 4]);
  for (const table of result.tables) assert.equal(table.teacherId, table.memberIds.length === 2 ? 'A' : 'B');
});

test('an attending owner can lend a copy while playing a different game', () => {
  const input = {
    members: [
      member('A', { g: 'pass', h: 'want' }), member('B', { g: 'want' }),
      member('C', { g: 'will' }), member('D', { h: 'want' }),
    ],
    games: [
      game('g', [offer('A', [], { teach: false }), offer('B', [2], { own: false })]),
      game('h', [offer('A', [2])]),
    ],
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.equal(result.score.seated, 4);
  const borrowed = result.tables.find(table => table.gameId === 'g');
  assert.equal(borrowed.copyOwnerId, 'A');
  assert.ok(!borrowed.memberIds.includes('A'));
});

test('one copy cannot supply two simultaneous tables and absent owners cannot supply copies', () => {
  const input = {
    members: ['A', 'B', 'C', 'D'].map(id => member(id, { g: 'want' })),
    games: [game('g', [offer('A', [2]), offer('B', [2], { own: false }), offer('absent', [2])])],
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.equal(result.tables.length, 1);
  assert.equal(result.score.seated, 2);
});

test('a valid fixed table reserves its participants and copy before automatic allocation', () => {
  const input = {
    members: ['A', 'B', 'C', 'D'].map(id => member(id, { g: 'want' })),
    games: [game('g', [offer('A', [2]), offer('C', [2], { own: false })])],
    fixedTables: [{ id: 'booked', gameId: 'g', memberIds: ['A', 'B'], teacherId: 'A', copyOwnerId: 'A' }],
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.equal(result.tables.length, 1);
  assert.equal(result.tables[0].fixed, true);
  assert.deepEqual(result.unassignedMemberIds, ['C', 'D']);
});

test('an invalid fixed table never forces Pass or silently reallocates its named people', () => {
  const input = {
    members: [member('A', { g: 'want' }), member('B', { g: 'pass' }), member('C', { h: 'want' }), member('D', { h: 'will' })],
    games: [game('g', [offer('A', [2])]), game('h', [offer('C', [2])])],
    fixedTables: [{ id: 'mistake', gameId: 'g', memberIds: ['A', 'B'], teacherId: 'A', copyOwnerId: 'A' }],
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.deepEqual(result.tables.map(table => table.gameId), ['h']);
  assert.deepEqual(result.unassignedMemberIds, ['A', 'B']);
  assert.ok(result.warnings.some(warning => warning.includes('B has not accepted')));
});

test('overlapping fixed promises are flagged rather than arbitrarily double booking people', () => {
  const input = {
    members: ['A', 'B', 'C', 'D'].map(id => member(id, { g: 'want', h: 'want' })),
    games: [game('g', [offer('A', [2])]), game('h', [offer('C', [2])])],
    fixedTables: [
      { id: 'one', gameId: 'g', memberIds: ['A', 'B'], teacherId: 'A', copyOwnerId: 'A' },
      { id: 'two', gameId: 'h', memberIds: ['B', 'C'], teacherId: 'C', copyOwnerId: 'C' },
    ],
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.equal(result.tables.length, 0);
  assert.ok(result.warnings.some(warning => warning.includes('another pre-arranged table')));
});

test('unrated players, stale Pass priorities and empty teaching counts never become consent', () => {
  const input = {
    members: [member('A', { g: 'want' }), member('B', {}, { priorityGameId: 'g' }), member('C', { g: 'pass' }, { priorityGameId: 'g' })],
    games: [game('g', [offer('A', [2])])],
  };
  assert.equal(allocateTables(input).tables.length, 0);
  assert.equal(allocateTables(input).warnings.length, 2);
  const noCounts = { members: [member('A', { g: 'want' }), member('B', { g: 'will' })], games: [game('g', [offer('A', [])])] };
  assert.equal(allocateTables(noCounts).tables.length, 0);
});

function competingPriorities(history) {
  return {
    members: [
      member('A', { alpha: 'want', zulu: 'want' }, { priorityGameId: 'zulu', history }),
      member('B', { alpha: 'want', zulu: 'want' }, { priorityGameId: 'alpha' }),
    ],
    games: [game('alpha', [offer('A', [2])]), game('zulu', [offer('B', [2])])],
  };
}

test('only explicitly feasible, non-fixed missed priorities earn waiting credit', () => {
  const missed = fulfilled('alpha', { priorityGameId: 'zulu' });
  assert.equal(allocateTables(competingPriorities([missed])).tables[0].gameId, 'alpha');
  assert.equal(allocateTables(competingPriorities([{ ...missed, priorityFeasible: false }])).tables[0].gameId, 'alpha');
  assert.equal(allocateTables(competingPriorities([{ ...missed, priorityFeasible: true, fixed: true }])).tables[0].gameId, 'alpha');
  assert.equal(allocateTables(competingPriorities([{ ...missed, priorityFeasible: true }])).tables[0].gameId, 'zulu');
});

test('fulfilling a still-selected priority resets waiting credit, including a fixed-table fulfilment', () => {
  const missed = fulfilled('alpha', { priorityGameId: 'zulu', priorityFeasible: true });
  for (const fixed of [false, true]) {
    const history = [missed, missed, fulfilled('zulu', { priorityGameId: 'zulu', fixed })];
    assert.equal(allocateTables(competingPriorities(history)).tables[0].gameId, 'alpha');
  }
});

test('historical bonuses are bounded and voluntary fixed-table compromises earn none', () => {
  const missed = fulfilled('alpha', { rating: 'will', priorityGameId: 'zulu', priorityFeasible: true });
  const two = allocateTables(competingPriorities([missed, missed]));
  const many = allocateTables(competingPriorities(Array.from({ length: 100 }, () => ({ ...missed }))));
  assert.deepEqual(two.score, many.score);
  const fixed = allocateTables(competingPriorities([{ ...missed, fixed: true }, { ...missed, fixed: true }]));
  assert.equal(fixed.tables[0].gameId, 'alpha');
  assert.equal(fixed.score.priorityAndFairness, 6);
});

test('results are deterministic across input ordering and preserve numeric IDs', () => {
  const input = {
    members: [member(1, { 10: 'want', 20: 'want' }), member(2, { 10: 'will', 20: 'want' })],
    games: [game(10, [offer(1, [2]), offer(2, [2], { own: false })]), game(20, [offer(2, [2])])],
  };
  const expected = allocateTables(input);
  const shuffled = { members: [...input.members].reverse(), games: [...input.games].reverse().map(value => ({ ...value, offers: [...value.offers].reverse() })) };
  assert.deepEqual(allocateTables(shuffled), expected);
  assertLegal(input, expected);
  assert.equal(typeof expected.tables[0].gameId, 'number');
  assert.equal(typeof expected.tables[0].memberIds[0], 'number');
});

test('twelve people and many interchangeable offers complete without duplicating scarce copies', () => {
  const ids = Array.from({ length: 12 }, (_, index) => `p${String(index).padStart(2, '0')}`);
  const titles = Array.from({ length: 24 }, (_, index) => `g${String(index).padStart(2, '0')}`);
  const input = {
    members: ids.map(id => member(id, Object.fromEntries(titles.map(title => [title, 'want'])))),
    games: titles.map((title, index) => game(title, ids.map((id, person) => offer(id, [2, 4], { own: person === index % ids.length })))),
  };
  const result = allocateTables(input);
  assertLegal(input, result);
  assert.equal(result.score.seated, 12);
  assert.equal(result.unassignedMemberIds.length, 0);
});

test('empty input is safe and a larger automatic pool returns a clear limit instead of guessing', () => {
  assert.deepEqual(allocateTables(), {
    tables: [], unassignedMemberIds: [], warnings: [],
    score: { seated: 0, priorityAndFairness: 0, desire: 0 }, feasiblePriorityMemberIds: [],
  });
  const result = allocateTables({ members: Array.from({ length: 13 }, (_, index) => member(`p${index}`, {})), games: [] });
  assert.equal(result.unassignedMemberIds.length, 13);
  assert.ok(result.warnings.some(warning => warning.includes('at most 12')));
});
