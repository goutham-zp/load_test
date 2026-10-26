// Which journey a users-mode virtual user opens next. Plain JavaScript with no k6 imports, so the k6 script and the
// tests share it.

// VUs on one token key: VU n (0-based) belongs to token key n % tokenCount.
export function vusOnToken(totalVus, tokenCount, tokenIndex) {
  return Math.max(1, Math.floor((totalVus - 1 - tokenIndex) / tokenCount) + 1);
}

// pages: the token key's journey numbers grouped by page, [[page 0 journeys], [page 1 journeys], ...].
// The VUs on a token key start on pages spread evenly over the list and move one page per visit, so every page is
// opened within (pages / VUs on the token key) visits, however short the step. Each lap round the pages takes the
// next recorded sample of a page, so repeated visits don't all ask for the same record.
export function pickJourney(pages, vuOnToken, vusOnTokenKey, iteration) {
  const n = pages.length;
  const pos = Math.floor((vuOnToken * n) / Math.max(1, vusOnTokenKey)) + iteration;
  const samples = pages[pos % n];
  return samples[(Math.floor(pos / n) + vuOnToken) % samples.length];
}
