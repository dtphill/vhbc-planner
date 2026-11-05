/** Scope the existing planner's catalogue queries to active entries.
 * Only these exact, fixed queries are changed. Account queries, saved history and
 * administrative restore queries use the original D1 connection unchanged.
 */
const QUERIES = new Map([
  ['SELECT * FROM games ORDER BY title COLLATE NOCASE', 'SELECT * FROM games WHERE archived_at IS NULL ORDER BY title COLLATE NOCASE'],
  ['SELECT id FROM games WHERE id=?', 'SELECT id FROM games WHERE id=? AND archived_at IS NULL'],
  ['SELECT game_id,value FROM ratings WHERE user_id=?', 'SELECT game_id,value FROM ratings WHERE user_id=? AND game_id IN (SELECT id FROM games WHERE archived_at IS NULL)'],
]);
export function activeCatalogueSql(sql) { return QUERIES.get(sql) || sql; }
export function activeCatalogueDb(db) {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return sql => target.prepare(activeCatalogueSql(sql));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' && key !== 'constructor' ? value.bind(target) : value;
    },
  });
}
export function withActiveCatalogue(base) {
  return {...base, fetch(request, env, ctx) {
    return base.fetch(request, {...env, DB:activeCatalogueDb(env.DB)}, ctx);
  }};
}
