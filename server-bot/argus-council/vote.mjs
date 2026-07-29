// ➤ The Council's ballot box: takes the 3 judges' votes and returns the verdict
// ➤ by majority. Pure function — no network, no files, no clock — which is why
// ➤ it is the easiest part of the Council to test. judge-shadow.mjs calls it.

// ➤ Normalises to 'show' | 'hide' | null. Accepts a bare vote or a whole judge
// ➤ object. null = the judge failed or gave no readable vote; it does not count.
function voteOf(v) {
  if (v && typeof v === 'object') v = v.vote;
  if (v === 'show' || v === 'hide') return v;
  return null;
}

// ➤ Majority over the VALID votes: 'tie' covers both a real 1-1 and having too
// ➤ few votes left. Nulls are dropped first, so they never tip the balance.
export function councilVote(votes) {
  const valid = (Array.isArray(votes) ? votes : []).map(voteOf).filter(Boolean);
  const show = valid.filter(v => v === 'show').length;
  const hide = valid.filter(v => v === 'hide').length;
  if (show >= 2) return 'show';
  if (hide >= 2) return 'hide';
  return 'tie';
}
