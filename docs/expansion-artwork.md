# Expansion artwork repair

Direct item lookup and batch thumbnail retrieval now request both `boardgame` and `boardgameexpansion` from BGG XML API2. Both parsers accept those two types, while still rejecting unrelated products and non-BGG image URLs. The exact linked BGG ID is preserved: an expansion uses its own thumbnail, not an inferred base-game cover.

The previous base-game-only request and parser excluded expansion records. This caused the existing Epic Ancients II entry (BGG 38927) to receive an empty cover cache entry even though its pasted link was correct. Deployment clears that entry only when its cached thumbnail is null; no catalogue entries, ratings, teaching offers, player counts, reservations or history are changed.

The existing last-known-metadata cache remains in use. Artwork retrieval still uses the item endpoint rather than title search and does not import a collection. BGG's image CDN must remain available to display the cover.

The media layer version is 1.2.2 to refresh its browser assets; the surrounding community and reservation features are unchanged. No database migration, new binding or secret is required.

Verification: `node --test tests/expansion-artwork.test.mjs`. All 16 focused checks pass on Node 22.16. Six of these fail against the preceding code. The checks cover base games, expansions, mixed responses, exact item identity, caching and stale fallback, member/catalogue access checks, redirect handling and response limits. Fixtures are synthetic and do not prove live BGG availability.

BGG type-filter reference: https://boardgamegeek.com/wiki/page/BGG_XML_API2#toc3
