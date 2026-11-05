/** Title relevance only: no BGG ratings or player-count metadata are used. */
export function normaliseSearchTitle(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function relevance(title, query) {
  if (title === query) return 0;
  if (title.startsWith(query + ' ')) return 1;
  if ((' ' + title + ' ').includes(' ' + query + ' ')) return 2;
  const words = new Set(title.split(' '));
  if (query.split(' ').every(word => words.has(word))) return 3;
  if (title.startsWith(query)) return 4;
  if (title.includes(query)) return 5;
  return 6;
}

/** Return a new array, retaining identifiers, edition years and local-catalogue flags. */
export function rankSearchResults(results, query) {
  if (!Array.isArray(results)) return [];
  const term = normaliseSearchTitle(query);
  if (!term) return [...results];
  return results.map((item, index) => {
    const title = normaliseSearchTitle(item.title);
    return {item, index, title, rank: relevance(title, term)};
  }).sort((a, b) => a.rank - b.rank
    || a.title.split(' ').length - b.title.split(' ').length
    || a.title.length - b.title.length
    || Number(Boolean(b.item.existingGameId)) - Number(Boolean(a.item.existingGameId))
    || a.title.localeCompare(b.title, 'en', {numeric: true})
    || a.index - b.index).map(entry => entry.item);
}

/** Re-rank the merged local/BGG response after the normal membership and rate checks. */
export function withRankedSearch(base) {
  return {
    ...base,
    async fetch(request, env, ctx) {
      const response = await base.fetch(request, env, ctx);
      const url = new URL(request.url);
      if (url.pathname !== '/api/search' || request.method !== 'GET' || !response.ok
          || !response.headers.get('Content-Type')?.includes('application/json')) return response;
      const data = await response.clone().json();
      if (!Array.isArray(data.results)) return response;
      const headers = new Headers(response.headers);
      headers.delete('Content-Length');
      headers.delete('ETag');
      return new Response(JSON.stringify({...data, results: rankSearchResults(data.results, url.searchParams.get('q'))}), {
        status: response.status, statusText: response.statusText, headers,
      });
    },
  };
}
