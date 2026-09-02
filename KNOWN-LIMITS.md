# Known limits

Three different things live here, and the difference matters more than the list.
Mixing them is how a real bug gets ignored and a deliberate decision gets
"fixed" by mistake — which has already happened once (see the CAD entry).

Every entry says where the guard lives **in the code**. That comment, not this
file, is what stops someone re-breaking it: this file rots, the comment sits at
the point of temptation.

---

## 1. Real defects, left unfixed on purpose

Things the bot genuinely gets wrong. They are open because the fix costs more
than the miss, not because nobody noticed.

### Bullet lists with no full stop soften a real requirement
`server-bot/scan.mjs`, above `bodyLanguageBlock`.

Some portals write their requirements as `* bullet * bullet * bullet` with no
punctuation, so the sentence splitter sees the whole block as ONE sentence —
1639 characters in the observed case. A "wünschenswert" two bullets away then
softens a genuine language demand and the offer comes through. Around 5-10% of
offer bodies arrive in that shape.

**Why it is still open:** the obvious fix is to split on the bullet marker. That
was already tried for `</p>` and `<br>` on 2026-07-18 and **reverted**, because
it also cuts a `Nice to have:` heading away from the list it introduces — and
that heading must keep covering its own bullets. A real fix has to tell a
softener that *introduces* a list from one sitting inside a sibling bullet, and
must be measured verdict by verdict before it ships. The cost of getting it
wrong is a good offer dropped in silence.

---

## 2. Looks like a bug, is a decision

Behaviour that reads as over-blocking until you know why. **Do not "fix" these
without asking the owner.** Each is pinned by tests that will fail if you try.

### "2 years with CAD software" on a junior title is dropped
`server-bot/requirements.mjs`, in `experienceScreen` (`field-mismatch`).

Two years is within the threshold, so dropping it looks wrong. It is deliberate:
asking for 2 years **in a field the candidate has at zero** disqualifies them
whatever the number is. An audit flagged this as over-blocking; it was a false
positive, contradicted by four of the owner's own tests. Left exactly as
calibrated.

### `Naval Architect` never gets through
`portals.yml`, and the judges' "foreign degree" list.

Naval architecture is a distinct degree the candidate does not hold, so it sits
with electrical, mechanical and civil. Adjacency to marine work is not enough.

### The language line is drawn per LANGUAGE, not per wording
`config/profile.yml`, `search.languages_blocked`.

"Je spreekt vlot Nederlands" (rejected) and "Je communiceert vlot in het
Nederlands" (applied to) are the same sentence. No wording rule separates them,
so the only honest line is which languages you list. A language you half-speak
still belongs in the list: what decides is whether the offer DEMANDS it.

### A blocked city does not sink an offer that also lists a city you accept
`server-bot/scan.mjs`, in `buildLocationFilter` (the `one(place)` helper).

A posting open in several places arrives as ONE string — `Barcelona, ES; Dubai,
AE`, the way Teamtailor joins them. Read whole, that offer was vetoed because
the block list saw Dubai, and the job in Barcelona was real and never seen. So
each place is judged on its own and the offer survives if **any** of them
passes.

The consequence reads as a leak and is not one: block or veto `Cádiz`, and an
offer listing `Rotterdam, NL; Cádiz, ES` still reaches you. It is the Rotterdam
seat that admitted it, and that seat is one you can take. An offer whose only
seat is the blocked city is dropped exactly as expected (measured against a live
veto, 2026-08-26: `Cádiz`, `Cadiz`, `CÁDIZ` and `San Fernando, Cádiz` all
blocked; `Barcelona` and `Cadizburg` untouched — the match is whole-word and
accent-blind on both sides).

### A field word that is part of the offer's own place name does not admit it

Boards glue the region into the title: "Chirurgien orthopédiste - Seine-Maritime (76)", a
nanny "à MARINES". Before the title filter looks for your field words, every segment of the
offer's own location that appears verbatim in the title is masked, so "Maritime" or "Marine"
has to be in the job part of the title to count. The other edge follows from it: a location
that is itself a field word ("Offshore", listed as the place of a posting) masks that word too,
and the title then needs another field word to pass. `--explain` says which of the two
happened ("the title's only keyword from your field is part of its place name"). Negatives
still read the whole title, which is the conservative direction.

### The Council has no decision power
`server-bot/argus-council/judge-shadow.mjs`. (`portals.yml` → `council.enabled` only
decides whether the judges RUN at all; it is not a switch for their authority.)

Their verdict is computed and written to the journal, and nothing else reads it
— no offer is ever kept or dropped because of a judge. That is on purpose. On 63
offers with a real decision behind them the Council agreed 49 times, but it
would have deleted 5 of the 9 offers the owner actually wanted, two of which they
had applied to. Every voting variant measured (unanimity, "The Good plus one")
still loses at least 2 of those 9. Until that number reaches zero, shadow only.

### The veto panel refuses to offer a word your own search is built on
`server-bot/vetoes.mjs`, in `clashesWithPositives`.

After a rejection the bot offers what it read in the offer as one-tap vetoes.
A word that overlaps one of your positive terms is never among them: reject one
bad mooring job and a single tap on `Mooring` would silently veto your whole
field, and the damage would only show as a list that quietly stopped filling.
A missing chip is cheap; that is not.

Pairs are held to a looser rule — offered unless they equal a positive exactly
— because a pair always narrows: `Divorce Lawyer` blocks divorce lawyers and
leaves every other lawyer alone, however central `lawyer` is to your search.

---

## 3. Gaps we know about and chose not to close

### Most rules have no test of their own
`server-bot/test-filter.mjs`.

Of the 447 title negatives, 132 have a worked example in the tests and 315 do
not. And of the blocked titles that depend on a negative at all — 130 of them —
**98 are the ONLY example of their rule** and just 2 are strictly redundant. The
suite is thin, not bloated. Writing 315 more tests would add bulk without adding
evidence: every test that exists is a real rejection, and the untested rules have
never been seen to misfire.

(Counted 2026-07-27. If you change the lists, the numbers move; what should not
move is the shape — nearly every test is the only witness of its rule.)

### `fs-atomic.mjs` has as much comment as code
Roughly two comment lines for every line of code, in a hundred-line file. The
reason the file exists *is* the comment: it holds the safe overwrite AND the
lock that stops two scheduled jobs erasing each other's work, and both are the
kind of thing a later reader would otherwise "simplify" away. Trimmed no
further on purpose.

### The bot reads the board's copy of an offer, never the page behind Apply
What the filters, the judges and the cover letters see is the text the job
board serves (Adzuna's description, a Workday API answer, a sitemap page). The
posting behind the **Apply now** link — the employer's or agency's own page —
is never fetched: it is one redirect away, often behind consent walls or
geo-blocks, and following it for every offer would double the traffic for a
text that usually repeats the board's.

The cost is that the two copies can differ (a real case: the destination page
carried a "cadre/executive" label and wording the Adzuna copy did not), and
the bot's verdict is only ever about the copy it read. When the destination
page says something the list did not, that difference is yours to judge —
the bot has not seen it.
