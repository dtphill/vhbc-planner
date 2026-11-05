# Search relevance and four-column catalogue

Available games uses four columns above 1050 CSS pixels, three up to 1050, two up to 800, and one up to 520. Existing typography, artwork, preferences and teacher-selected player counts are retained.

Search ranks exact normalised titles first, then title prefixes, complete phrase matches, all-word matches and partial matches. Case, accents, apostrophes and punctuation are normalised for comparison only; displayed names are unchanged. Equivalent matches favour an existing catalogue entry. Both local and external results are ranked together after the existing authentication and rate checks.

All validated results in BGG's size-bounded XML response are considered before returning the best 25. The `search:v2:` cache namespace avoids using older lists that were truncated before ranking. Thumbnail caches and user records are untouched.

Focused checks: `node --test tests/search-ranking.test.mjs`. Local browser layout checks covered widths 320, 390, 540, 768, 1024, 1100 and 1440 pixels, with no horizontal overflow and minimum 44-pixel button heights.
