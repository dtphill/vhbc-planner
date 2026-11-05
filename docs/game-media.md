# BGG game covers and attribution

Version 1.2.0 adds a non-blocking image layer around the existing Worker. Build entry: `src/worker-media.mjs`. It preserves existing authentication, meeting management and game preferences.

Linked games automatically display BGG's thumbnail in Available games and quick review, including games already in the catalogue. The cover links to that game's BGG page. Manual entries and missing covers use a restrained initials placeholder. Covers retain their proportions; artwork is not recoloured or cropped. Teacher-specified player counts are never imported or replaced.

## Data flow and safeguards

The browser requests at most 20 linked BGG IDs at a time through `/api/game-thumbnails`. The server reuses the existing bootstrap session/membership check and permits only IDs already in the group's catalogue. BGG requests use the existing `BGG_TOKEN` secret, server-side, against the fixed XML API2 `thing` endpoint. No credential is sent to the browser, image CDN or badge source.

Thumbnail URLs are cached for 24 hours in the existing `bgg_cache` table under `thumbnail:v1:` keys. A database-backed six-second cache-miss gate reduces duplicate upstream work across visitors. Requests have body limits, timeouts and bounded browser retries. Only HTTPS images from `cf.geekdo-images.com` are accepted. No XML entity expansion is performed; only item IDs and thumbnail URLs are extracted. The browser's script policy remains self-only. Artwork failure does not block ratings or attendance.

## Powered by BGG artwork

The footer links back to https://boardgamegeek.com/ and displays the unmodified orange-and-purple Powered by BGG lockup at a legible size. BGG's attribution guidance is https://boardgamegeek.com/using_the_xml_api .

Asset provenance: the PNG is the existing lockup mirrored by Board Game (bodoge.hoobby.net), at https://dm1i7q1ruvbhg.cloudfront.net/assets/powered_by_bgg-9f2993c7fad826d5407c35b5c8117b08d2a6cdf5beb1f0c02d06a7dc7f5cdd7f.png . It is not a newly drawn or generated logo. The fixed image is validated as PNG and cached behind the site's `/media/powered-by-bgg.png` route, so members' browsers do not contact that mirror directly. No BGG token is used for this asset request.

## Deployment and verification

No new database migration or package is needed. Keep the existing DB, APP_URL, BETTER_AUTH_SECRET and BGG_TOKEN bindings. `npm run build` builds the media entry into the existing dist/worker.mjs destination. Focused tests: `node --test tests/game-media.test.mjs` (Node 22.16 or newer). The 14 focused tests and offline desktop/mobile interface checks use fixtures; a signed-in live browser is needed to verify the complete BGG image path with the production token.
