# Why the code is the way it is

Notes that used to live next to the code: the incident behind a rule, the date it
was found, what it looked like before. The rule itself stays in the source as a
short comment; the story is here, by module and function, in the order the code
has them. Line numbers are where each note sat when it was moved (2026-09-01).

## argus-council/judge-shadow.mjs

### offerKey · line 54

Same Adzuna normalisation as scan/housekeep (audit 2026-07-25): this third
copy never received it, so the SAME offer arriving once as /land/ad/ and
once as /details/ counted as two and was judged (and paid for) twice.

### reason · line 90

FULL reason: only whitespace/newlines are collapsed so it fits on
one line. It is NOT truncated (it used to be cut at 220 and split sentences).

### readCouncilConfig · line 132

WHAT THE JUDGES ARE GIVEN, and whether it is worth asking them (2026-08-26).
A careers page can answer with a cookie wall and a menu and not one word
of the advert. Fed that, two of the three judges — forbidden to hide
without quoting a barrier — defaulted to show, and the verdict was pinned
to YES by construction: a [YES] that meant "we could not read it" and
looked exactly like one that meant "this fits". Case #1005, an offer whose
stated degree none of them ever saw.
  'judge' — a body worth reading, or no URL at all (the dropped samples
            are judged by title on purpose; that is their design).
  'retry' — the board would not answer this time: no reply at all (0),
            a rate limit (429), a block (403) or a server error. Not a
            verdict, not journalled; the next run asks again. Measured
            2026-09-01: Adzuna serves 3-6k characters of offer when asked
            one page every 6 s, and 429/403 when asked in a burst.
  'blind' — the board answered, but with fewer than minChars of readable
            text (a cookie wall, a page that is gone). Journalled as
            blind, shown as [?], no judge asked.

### sampleDropped · line 164

Reads a SAMPLE of DROPPED offers from data/scan-explain.txt. It only
keeps the ones the filter killed by title/language/years (the interesting
false negatives) and returns only the first `limit`. NOTE: that
file does NOT carry the URL, so these offers are judged BY title ONLY
(empty body). Line format:
  [REASON] explanation — Title | Company | Location (source)
`judgedKeys` makes the limit count only offers NOT yet judged (audit
2026-08-08): scan-explain.txt is rewritten each scan with a deterministic
sort and dropped offers persist for weeks, so the first N lines were the
SAME already-judged offers every run — filterUnjudged then deleted them
all, and the false-negative monitoring this sample exists for starved.

### main · line 252

A FLAG WITH NO NUMBER MUST NOT MEAN "NO LIMIT" (audit 2026-07-31).
parseInt of a missing or non-numeric value gives NaN, Number.isFinite(NaN)
is false, and the cap below was then skipped altogether — so typing
"--limit" with nothing after it, or with a word instead of a number,
quietly judged the WHOLE queue and spent the AI calls to match. This flag
is the documented way to try a small run by hand, so getting it wrong has
to stop with a message rather than run wild.

### dropped · line 332

If ANY judge could not speak (Claude out of credit, not authenticated,
down), this is NOT a verdict: we do not journal it. Journalling it
would mark the offer as "already judged" and it would never be looked
at again — which is exactly what happened on 2026-07-24.
ANY, not ALL (audit 2026-08-08): the judges run one after another for
minutes, so a spend limit reached MID-OFFER left one real vote and two
failures — and the old all-failed check waved that through: a 1-vote
"tie" journalled as final, never retried, against the exact contract
engine.mjs states for failed:true. Skipping means the next run
retries; we stop the batch because the rest would fail the same.

### dropped · line 349

It APPENDS to BOTH logs; it never overwrites anything.
Under the journal's lock (audit 2026-08-08): reconcile.mjs rewrites
the whole file under it, and an append landing between its read and
its write was erased — the offer re-judged later, three paid AI calls
repeated. Held for the one appendFileSync, nothing more.

## argus-council/judges.mjs

### profileBriefing · line 123

THE PROFILE, IN THE JUDGE'S OWN WORDS (audit 2026-07-25). The default prompts
below carry a marine example, so after a complete /start a non-marine user
still got judges reasoning about mooring and STCW. This block is appended to
every prompt and states, from config/profile.yml, what THIS candidate is —
which overrides any example the prompt text may contain.

### list · line 153

The study level was missing from this briefing, and it cost a verdict: a
judge QUOTED a hard Master's requirement and still voted show, because no
line here said the candidate does not hold one.

### parseVerdict · line 200

"verdict" added 2026-07-25 (audit): a judge answering with that key
had its perfectly readable vote thrown away.

### parseVerdict · line 211

2nd attempt (plan B): there was no usable JSON. Scan for the vote word
directly in the text and use the whole text as the reason.
FIXED 2026-07-25 (audit): this used to scan the WHOLE text for the vote
word, so a judge that QUOTES the offer — exactly what we ask it to do —
flipped its own verdict: quoting produces unescaped quotes (invalid JSON)
and the loose word "show" inside a HIDE reason won. Now we read the vote
KEY even out of broken JSON, and if BOTH words appear with no key we
admit we cannot tell instead of guessing.

## argus-council/reconcile.mjs

### main · line 100

READ-FILL-REWRITE UNDER LOCK (audit 2026-08-08). This runs by hand or on
its own cron, OUTSIDE the scan+council flock — and the Council appends a
verdict per offer across a batch that lasts minutes. A line appended
between this read and the rewrite was erased: that offer was re-judged
later (three paid AI calls repeated) and its history vanished. The lock
is held for the milliseconds of the read and write only; the shrink
guard stays as the second line of defence.

### main · line 116

SAFETY 2026-07-25 (audit): this rewrites the WHOLE journal from the lines
it managed to parse, so any line it could not read was silently deleted.
A journal is history: we refuse to shrink it.

## argus-mail/classify.mjs

### (module level) · line 21

A refusal, and it has to be caught in both directions: the negative ("we
will not continue with you") and the positive, which reads like good news
until the sentence ends — "continue with OTHER candidates", "verder te
gaan met andere kandidaten".
"not to (go|move) forward" added 2026-08-05: a real employer wrote "we
have decided not to go forward with your application" — negation BEFORE
the verb, which neither "not moving/proceeding" nor "decided to go
forward with another" covered, so two real rejections sat as acknowledged.

### (module level) · line 38

Receipts describe what MIGHT follow in the words of a real invitation:
"we will inform you whether we see the right fit TO INVITE YOU FOR AN
INTERVIEW" is a company that has not decided, and it was read as one.
These words mark that pending decision — deliberately NOT "if you are
available" or "if it suits you", which is how a genuine invitation is
politely worded. WHO it hangs on is irrelevant ("if YOU are selected, we
will invite you" passed as a real interview in English, German and Dutch),
so the maybe is pinned to selected/shortlisted/successful, a few words
apart, and to nothing else — "a match" and "the right fit" describe the
OFFER suiting YOU, and binned real invitations.

## argus-mail/listen.mjs

### windowFrom · line 34

HOW FAR BACK TO READ: to the day of your OLDEST recorded application, and
not one day further. An email that arrived before you applied cannot be an
answer to it, so reading it would only produce noise to throw away — the
first version read 120 days and spent most of its effort on 36 messages
belonging to applications made before there was anywhere to record them.
It also means the bot reads as little of your mailbox as the job allows,
which is the right default for something with a standing key to it.

### main · line 80

How many messages the mail run will look at in total. Gmail hands back at
most 500 per page and listMessageIds now walks the pages, so this number is
a real ceiling rather than a page size (audit 2026-07-31). It used to be
both, and that quietly cut the scan short at the first page: the window
starts at your oldest application and only ever grows, Gmail answers
newest-first, so it was the OLDEST messages that fell off the end — the
applications they answered sat on "no reply" for ever, however many
rejections or interview invitations had actually arrived.

### main · line 107

SAY SO WHEN THE CEILING BINDS (audit 2026-08-08). Gmail answers
newest-first and the window only grows, so hitting the cap silently
drops the OLDEST messages — the replies to the oldest applications —
and, because this status is rebuilt from scratch each run, rejections
and interviews already reported would quietly regress to "no reply".
That is the same failure the 2026-07-31 note above says was fixed, back
at a higher number; at least it must never again happen in silence.

### main · line 165

WHAT the tie was about (audit 2026-08-01). Only the count used to
survive, so the report could say "1 email fit more than one
application" and nothing else — not the employer, not whether it was
a refusal or an invitation, not which applications were tangled. That
is not something anybody can act on, and the rule that produces ties
promises you can. Ids and kind only: no subject, no sender, no text.

### main · line 193

GHOSTED HAS TO BE ON THIS LIST. It was missing, so the lines added up only
while no application had yet passed the 60-day mark — and the first one to
pass it would have gone missing from the summary without a word.

## argus-mail/match.mjs

### hasWord · line 55

A WHOLE WORD, never a fragment of one. "Van Oord" reduces to the token
"oord", and a Dutch rejection from a different company contained the word
"beoordeling" — so Van Oord scored as if it had been named. The boundary
is written with \p{L} rather than \b because JavaScript's \b only knows
ASCII and would break on the first accent.

### linkOutcomes · line 199

IDENTITY ALONE DECIDES WHICH VACANCY (audit 2026-07-31). There used to
be a third route to "clear": identity level and a better total. But the
only ingredients of the total that are not identity are the date bonus
and the city — so when you had two applications at the SAME employer and
an email that named nothing but the company, the one you applied to most
recently won on its date bonus, and a rejection was filed against a
vacancy that had not rejected you. That flatly contradicts what this file
says twice over: timing corroborates an identity, it never outranks one.
Level identity is now a TIE, which is the honest answer — the email is
shown to you and you say which one it was. A gap costs you a question;
a wrong link costs you the truth.

### linkOutcomes · line 218

A BOUNCE IS THE ONE THING THAT LINKS TO ALL OF THEM. Every other kind
of message is about ONE vacancy, so guessing between two would put a
rejection on the wrong job. A bounce is not about a vacancy at all —
it says mail to that ADDRESS did not get through, which is equally
true of every application sent there. Real case: two applications to
the same employer on the same day, one failure notice. Reported as an
unresolved tie, it told you nothing; the one thing you could act on
was the thing that stayed silent.

## argus-mail/report.mjs

### (module level) · line 2

WHAT IT IS: the "status" command's text.

NOTHING IS CUT SHORT. An earlier version clipped company and job titles
with an ellipsis to keep every row on one line, which produced things like
"Production Automation Sys…" — less information than the full name and it
looks broken. Long rows wrap on a phone, and that is fine.

THE ORDER IS HOW FAR EACH ONE GOT, least first: no answer, receipt,
rejection, interview. EVERY CIRCLE HAS ITS WORD NEXT TO IT — the count
line used to be five colours and five numbers and meant nothing unless you
already knew the code.

### of · line 73

NOTHING MAY FALL BETWEEN THE STATES (audit 2026-07-31). The states this
report knows about are the ones listed above; an application in any other
state appeared in no section AND in no count, while the header line right
here still added it to the total — so the numbers quietly contradicted
each other and one of your applications was nowhere on the screen. It is
an easy state to reach: rename a state in one file and forget the other.
A report that admits it is confused is better than one that hides an
application, so it now says so out loud, with the unknown names.

### of · line 116

NAME THEM (audit 2026-08-01). A bare count is not something you can
act on: it does not say which applications are tangled, nor whether
the message was a refusal or an invitation — and an invitation left
unassigned is the most expensive thing this whole module handles.
With the numbers in front of you, "no N" settles a refusal and you
know to go and read the mail yourself when it is an invitation.

## argus-mail/status.mjs

### mine · line 84

IT NEVER ARRIVED, so nothing else that happened to it matters. First
because it is not a verdict on you but the reason there is none — and
the only one of these states you can still do something about.
UNLESS SOMETHING CAME BACK (audit 2026-08-08): match.mjs deliberately
fans an ambiguous bounce out to every application at the same
employer, so a bounce sitting next to a receipt, a rejection or an
interview is proof the bounce belonged to ANOTHER application there —
not that this one never arrived. The old rule buried an interview
under "Never arrived", the loss this module calls its most expensive.

## claude-cli.mjs

### (module level) · line 1

WHAT IT IS: the single place from which Argus calls Claude on the server.
WHY IT EXISTS: cover-letter.mjs and argus-council/engine.mjs each had their OWN
copy of this, and the copies drifted — the Council one never learned to tell
a "you ran out of credit" from a real answer.
THE BUG IT FIXES (2026-07-25 audit, seen for real on 2026-07-24): when the
account hits its monthly spend limit, the claude program prints the warning
on its NORMAL output (stdout), not on the error channel. The old check was
"failed only if it errored AND printed nothing", so that warning was taken
for a valid answer: it ended up as the BODY of a cover-letter PDF ("Dear
Hiring Manager, You've hit your monthly spend limit...") and as the three
judges' reasoning in the Council journal. Now the text is inspected: if it
looks like a CLI complaint, it is a FAILURE, whichever channel it arrived on.

### (module level) · line 19

Where the "claude" program lives. WATCH OUT: the user cron starts with a
minimal PATH (/usr/bin:/bin) with no /usr/local/bin, and a bare "claude"
gave "spawn claude ENOENT" in production (real case: cover 594, 2026-07-18).

### raw · line 83

1) IT ERRORED AT ALL → failure, even with output already on screen.
This used to read "errored AND said nothing", so a run killed by the
six-minute timeout half-way through a letter came back as a SUCCESS
carrying half a letter: rendered into a PDF, sent, and cut off
mid-sentence. The CLI exits 0 when it has finished, so a non-zero
exit means the answer is not finished, whatever is on screen.

## cover-letter.mjs

### loadJson · line 50

The launcher, the path lookup and the "why did it fail" classification
all live in claude-cli.mjs now, shared with the Council (they used to be
two separate copies that drifted apart).

### runClaude · line 55

Launches Claude on the server (automated mode, no window) with the job
of writing the letter, authenticating with the stored token.
Now delegates to the single shared launcher (server-bot/claude-cli.mjs),
which ALSO catches the case where claude complains on its NORMAL output
(the spend-limit warning) instead of on the error channel — that used to be
taken for a valid letter and ended up printed inside the PDF.

### renderPdf · line 227

Turns the HTML page into an A4 PDF using Playwright's Chromium.
IT INSTALLS THE BROWSER IF IT IS NOT THERE (2026-08-06). Playwright ships
as a library and downloads its browser separately, so `npm install` alone
leaves a hole that only shows up at the first `cover N` — and it reopens
on its own whenever npm updates playwright to a version whose browser
build is not the one on disk (that is exactly what happened here: an
unrelated install bumped 1.58→1.62 and every letter would have failed).
One attempt, then the error stands: a second failure is a real problem.

### coverFileBase · line 261

The file name, ALWAYS in the requested format (2026-07-18):
CoverLetter_Surname_Firstname_Company. The "Surname_Firstname" comes from
letter_name ("Jane Doe" → surname_firstname) and the company is appended in
PascalCase, without accents or symbols ("Jan De Nul Group" → JanDeNulGroup).
It ENDS at the company on purpose: the file name is what a recruiter sees
attached to the mail, and an internal offer number there reads like a
reference you forgot to remove.

### coverFileBase · line 276

WHO OWNS WHICH FILE NAME. The offer number used to be glued to the name to
stop two open roles at the SAME employer from overwriting each other (audit
2026-07-25). This little file does the same job without putting it in the
name: { "730": "CoverLetter_Doe_Jane_JanDeNulGroup" }.

### makeCoverLetter · line 311

If the portal gave us no text, the letter was written from the title and
the company alone. It is still usable, but you must know before sending
it (audit 2026-07-25: 3 of 14 live offers came back with an empty body
and nothing said so).

### makeCoverLetter · line 322

Ask the index which name belongs to this offer, then write the answer
back so the next letter knows the name is taken.
UNDER LOCK (audit 2026-08-08): each `cover N` is its own detached
process, so two overlapping covers for the same company could both load
the index before either wrote — resolving the SAME file base (one PDF
silently overwriting the other, the very collision the index exists to
prevent) and losing the loser's entry to last-writer-wins. The lock
covers the load-resolve-write milliseconds, not the letter writing.

### coverToTelegram · line 358

WHY THIS EXISTS AS A PROGRAM AND NOT JUST A FUNCTION. Claude takes minutes
to write a letter, and the listener used to wait for it. The listener runs
once a minute under a lock, so while it waited NOTHING else worked: a
"seen", a "list", a "no" — all of them queued behind a PDF. Now the
listener starts this and lets go; this finishes the job and reports here
itself. Kept pure of the listener so it can also be run by hand:
  node server-bot/cover-letter.mjs --offer 412

### coverToTelegram · line 378

Warn if the portal gave no text: the letter is then written from the title
and company alone, so it will be generic. Better you know before sending.
AND THE WARNING IS NOW ACTUALLY SAID (audit 2026-08-08): `thin` was
computed, returned, and read by nobody — this comment promised a warning
the caption never carried, and the 3-empty-letters-of-14 incident that
motivated it was still happening in silence.

## esco.mjs

### occupationsForTerms · line 57

From a bag of terms to the occupations ESCO says they name. Occupations
are searched by NAME, per term — deliberately NOT ESCO's skill→occupation
graph (measured live 2026-08-23): that graph exists for surprising jumps,
and on a mixed CV it crowned branch managers, bingo managers and
headmasters. A name search speaks the CV's own vocabulary: "accounting"
finds accountants, "sales negotiation" finds sales people — each term its
own profession, so an accountant-and-salesman CV surfaces BOTH,
separately. `deps.esco` is injectable so tests run without the network.

## filters.mjs

### lead · line 49

Optionally allows the plural and the German female forms
(Technikerin, Projektmanagerinnen) without opening the door to other words.
"-es" added 2026-07-13: the Spanish plural in -ores ("Soldadores")
dodged the negative "Soldador" (#566). "-en" is the German and Dutch
plural (Bacheloranden #753, and Senioren, Professoren, Directeuren
would all have dodged their negatives the same way).

### buildCompanyFilter · line 63

COMPANY blocklist (portals.yml → company_filter.blocked): no
offer from those companies gets in, whatever its title (the user
2026-07-18: Amazon). Whole word, case-insensitive. Returns
true if the company PASSES; .explain() says which term blocked it (--explain).

### unlessRe · line 95

WORD-aware rescue (audit 2026-07-25): the unless words were plain
substrings, so "Windows Automation Consultant" was rescued because
"Windows" contains "wind". Each one is matched with its own boundary.

### placeSegments · line 104

A PLACE IS NOT A FIELD (field cases 2026-08-26). Boards glue the region
into the title — "Chirurgien orthopédiste - Seine-Maritime (76)", a
nanny "à MARINES" — and a positive like "Maritime" or "Marine" then
fires on the geography. Before the positives are checked, every segment
of the offer's own location that appears verbatim in the title is
masked out, so the field words have to be in the JOB part of the title.
Only whole location segments, five letters or more: a title that merely
shares a word with its city ("Offshore Engineer" in "Offshore Base,
Aberdeen") loses nothing, because "offshore base" is not in the title.
Negatives still read the whole title: a blocked word inside a place
name still blocks, which is the conservative direction.

### matchers · line 155

FIXED 2026-07-25 (audit): every term is matched as a WHOLE WORD, not as a
loose substring. Before, only ALL-CAPS acronyms got that treatment, so
"Peru" blocked Perugia (Italy) and "Oman" blocked Romans-sur-Isère
(France). Whole-word still catches what it should: "Saudi" → "Saudi Arabia".

## fs-atomic.mjs

### trimLog · line 8

Keeps a cron log from growing for ever (audit 2026-08-08): the Linux/mac
schedule appends listener.log and scan.log on every run and nothing ever
rotated them. Called by the writer itself at startup — the shell keeps the
file open with O_APPEND, so a truncation here never corrupts its writes,
they simply continue at the new end. Over the cap, the newest tail is kept.

### tempNameFor · line 21

The scratch name to write to before renaming. UNIQUE per write (audit
2026-07-25): with a fixed ".tmp" the 07:30 housekeep and a seen.mjs fired
from Telegram shared one scratch file and could rename a mixture of both
into place. It sits NEXT TO the target on purpose — a rename is only
atomic within one filesystem, so a temp file in /tmp would silently
degrade into a copy on a machine where /tmp is its own mount.

### writeFileAtomic · line 42

SWEEP UP THE SCRATCH FILE WHEN THE WRITE FAILS (audit 2026-07-31). Your
real file is safe whatever happens — that is the whole point of writing
aside first — but until now a failed write abandoned its scratch file,
and nothing anywhere in the project ever deleted one. Provoked in
testing: three kills between the write and the rename left three orphans
sitting in the data folder; a full disk left one behind per attempt. So
the litter piled up hardest exactly when the disk was already full.
The error is re-thrown untouched: tidying up must not hide the failure
from the caller.

### sleepSync · line 56

The atomic write above stops a reader ever seeing half a file. It does
NOT stop this: two jobs read the same list, each adds its own change, and
the second one to write erases the first. Measured on the real writer,
eight writers going at once kept 200 of 1600 lines.

THAT IS NOT THEORETICAL HERE. Several scheduled jobs share one pending
list: the scanner appends every two hours, housekeep deletes twice a day,
the Telegram listener rewrites it every time you mark an offer — every
minute, so it can land in the middle of either. Their cron locks are all
DIFFERENT, which only stops a job overlapping itself.

A DIRECTORY IS THE LOCK. mkdir either creates it or fails, in one step,
on every filesystem — no flag, no library, and nothing left running. It is
held for the milliseconds of the read-and-write, never for the minutes a
job spends on HTTP.
IT ALWAYS PROCEEDS RATHER THAN GIVING UP: after the timeout it assumes the
holder died and takes the lock. Refusing instead would mean silently
dropping an offer or ignoring a decision, and a race that loses one line is
a smaller harm than a job that quietly does nothing.
THE LIMIT OF THAT CHOICE, stated plainly: clearing an abandoned lock can
itself race, so two jobs could both get in — but only once a lock has sat
untouched for five seconds, which means a job was already killed mid-write.
A real hold lasts milliseconds, so in normal running it cannot arise.
A real pause inside synchronous code. This used to be a spin loop, which
burns a whole core: harmless for the milliseconds of normal contention, but
a permanent failure (a read-only data folder, a full disk) meant five
seconds at 100% CPU on EVERY write, from every job, for as long as the
machine stayed broken. Atomics.wait sleeps without a callback, so the four
callers stay synchronous.

## gmail-auth.mjs

### (module level) · line 2

WHAT IT IS: the ONE-TIME authorisation for the Gmail reader. You run it,
a browser opens, you approve, and it writes gmail-token.json. After that
the bot renews itself and this file is never needed again.
RUN IT ON A MACHINE WITH A BROWSER — your laptop, not the headless
server. Google removed the old copy-the-code flow, so the reply has to
come back to a little server this script opens on 127.0.0.1. Copy
gmail-token.json to the server afterwards.

IT DOES NEED THE CLIENT SECRET, despite what the documentation says.
Google's own page marks client_secret "Optional" for installed apps and
states that they "cannot keep secrets" — so this was first written without
one. Their token endpoint then answers "client_secret is missing". The
documentation and the server disagree; the server wins. PKCE is still used
(it is what protects the code in transit), the secret is simply required
alongside it.
WHAT IT ASKS FOR: gmail.readonly, and nothing else.
RUN: node server-bot/gmail-auth.mjs

### main · line 60

THIS SCRIPT DOES NOT OPEN A BROWSER, ON PURPOSE.
It used to try, and an OAuth URL turns out to be an awkward thing to hand
to an operating system: `cmd /c start` reads the "&" between parameters as
"end of command" and delivered only the first one, and rundll32 mangled it
a different way and opened a mailto: link. Both failures looked like a bug
in the URL, and the URL was correct every time.
You run this once, ever. Printing the address and letting you click it is
one second of your life and removes a whole class of platform bug from the
one step where a confusing error is most expensive.

### escHtml · line 103

Settle only once the reply has actually gone out, and close the
server from here rather than from a finally(). Tearing the loop down
while a response is still in flight is what produced a libuv
assertion on Windows instead of a readable error.
The error text comes from the request's own query string, so it is
escaped before it goes back inside HTML (CodeQL round, 2026-08-24).
The window is a loopback server alive for seconds, but an escape
costs one line and the alternative is echoing attacker-shaped text.

## gmail.mjs

### listMessageIds · line 110

The ids of the messages matching a Gmail search query (the same syntax you
type in Gmail's own search box, e.g. 'label:Argus newer_than:30d').
IT FOLLOWS THE PAGES (audit 2026-07-31). Gmail hands back at most 500 ids at
a time plus a token for the next page, and that token used to be thrown
away — so the search stopped dead after one page, without saying so. The
search window starts at your OLDEST application and only ever gets longer,
and Gmail answers newest-first, so as soon as the window held more than a
page the OLDEST replies dropped off the end: those applications sat on "no
reply" for ever even though the answer was in the mailbox. `max` is now the
total number of ids wanted, not the size of one page.
The number of pages is capped too, so a query that somehow never runs out
cannot turn the mail run into a loop that never finishes.

## housekeep.mjs

### (module level) · line 44

To refresh the Telegram list after deleting: otherwise you keep seeing on
your phone offers that no longer exist (audit 2026-07-25).

### ensureInHistory · line 80

(2026-07-18: "the [x]s are noise") Housekeep NO LONGER hides lines with
[x]: it DELETES them from the pipeline. So the same offer doesn't sneak back
in as "new" on the next scan, before deleting it makes sure its
URL is in data/scan-history.tsv (the scanner's anti-repeat memory).
The "| visto" lines (the user's decisions) don't pass through here: they're kept.

### rewritePipelineWithout · line 101

Builds a "fingerprint" of each offer (company + title) to catch duplicates
even when the company name varies: "Connetix" and "Connetix Nederland"
reposting the same title are one offer, not two.
(2026-07-18, Lonza case #595/#602) Same as the scanner's roleKey:
the gender tags "(m/w/d)"/"(All Genders)" and the schedules
"80-100%" are stripped before comparing — the same role reposted with
another tag no longer dodges the user's decision.
SAFE REWRITE (audit 2026-07-25). housekeep reads pipeline.md, then spends
minutes doing HTTP checks, then rewrites the file from that OLD snapshot —
so anything you did meanwhile from Telegram (a "seen", a "no", a new scan)
was silently undone. Instead of writing back our stale copy, we re-read the
file at the last moment and delete only the LINES WE DECIDED ON, matched by
their exact text. Whatever else changed in between is preserved.
THE ONLY PERMANENT DELETE IN THE PROJECT: it rewrites your pending list
without the lines given. Exported, and with the file to work on as an
argument, so a test can prove what it removes without going anywhere near
your real list — an audit found it had no test at all, which for the one
function that destroys data is the wrong place to be short of them.
Matching is EXACT on the trimmed line: a line that changed in the meantime
no longer matches and survives, which is the safe way round.

### looksLikeAnOutage · line 138

Deleting here is PERMANENT: the link goes to the anti-repeat history and
the scanner will never propose that job again. "Dead" is decided from a
single HTTP answer, and some of those answers (a 403 while a portal blocks
us, a 404 from a site that is down, our own rate-limiting) mean "not right
now", not "withdrawn". When MOST of the list dies at once, that is a portal
or network problem, not a dozen companies closing their vacancies in the
same minute — so nothing is deleted and the next run re-checks.
EXPORTED, and used by BOTH delete paths (audit 2026-07-31). It used to be a
local inside the daily check only: the Sunday full clean-up deletes strictly
more and had no brake at all. Measured against a portal answering 404 to
everything, the daily run stopped with 14 offers intact and the weekly run,
seconds later, left 0.
NO FLOOR ON THE LIST SIZE. The old version only protected lists of 5 or
more, which had it exactly backwards: a short list is where losing
everything hurts most, and "3 of 3 died in the same second" is just as
TWO WAYS TO TRIGGER, because a ratio alone gets it wrong at both ends.
A ratio with no floor made an ordinary short list impossible to clean: one
genuinely withdrawn offer out of two is half of them, so the brake fired
every single run and the dead link stayed for ever. A count alone would
miss "everything died at once" on a small list.
So: five or more dead AND at least half — many at once is an outage
whatever the list size — OR every single one dead, from three up, which
cannot be a coincidence either. One or two dead links get deleted, which
is what they are for.

### fuzzyKey · line 174

(2026-07-19) the gender-tag separator can be a space: "(x w m)".
The same titleKey the scanner's roleKey uses (text.mjs): one
normalisation, so a re-post the scan recognises, the cleanup does too.

### fuzzyKey · line 178

FIXED 2026-07-25 (audit): it used to keep only the FIRST word of the
company, so "Royal IHC" and "Royal Niestern Sander" shared one key and a
genuine second vacancy was deleted as a duplicate.

### fuzzyKey · line 191

Oracle/Workday job pages are SPAs that answer 200 even for withdrawn
postings ("the link doesn't work" — the user, 2026-07-06, on a filled DNV role).
Their APIs do tell the truth, so ask them directly.

### isDeadWorkday · line 224

Same for Workday: it asks its data service; if it answers "doesn't
exist" (404 or 403) or brings no offer detail, then it's closed.
VERIFIED LIVE 2026-07-18: Workday answers 403 "permission denied"
for WITHDRAWN offers (even a real browser gets 403 and shows
"the page you are looking for doesn't exist"), and plain 200 for the
live ones. Before, the 403 was read as "live" → the dead Fugro ones stayed
in the list forever (the user's 4 "the link doesn't work", jul 16-17).

### isDeadAdzuna · line 244

Is an Adzuna offer dead? Pipeline URLs come as /details/{id} OR as
/land/ad/{id}, and that second form is a redirect to an external board
that answers 200 forever — 15 dead offers slipped past the daily check
that way (2026-07-10). So it always checks /details/{id}, which is the
truth: verified live, a dead ad gives 404 and a live one 200.

### isLikelyDead · line 292

Classifier verdict + anti-false-dead second opinion (caught
2026-07-18): if the "expired" comes only from a phrase in the text and the
page still has an apply button, it's considered live (see scan.mjs).

### politeFetch · line 317

Slot allocator, not a last-request timestamp (audit 2026-08-08, the same
fix as scan.mjs): under 5-way concurrency every waiter computed its wait
from the same stale timestamp, woke at the same moment and fired together
— bursts that provoke the very 429s whose "inconclusive → keep" verdict
lets dead offers survive the daily check (the #61 failure above).

### politeFetch · line 341

15 s penalty after a 429, same as scan.mjs (audit 2026-07-25): the
fix was applied there in July but this copy kept the old 8 s, so the
retries here still died inside the same rate-limit window.

### fetchDescriptionByUrl · line 386

Is it from Adzuna? Download the details page itself and try to extract
the CLEAN region of the description (adp-body). If obtained, the
URL is noted in adzunaJdClean: with clean text the body LANGUAGE can
also be checked (before, Adzuna was blind and French offers
piled up — 10 rejections from the user, 2026-07-13).

### next · line 414

ERROR ISOLATION 2026-07-25 (audit): a single throwing task used to abort
its whole worker, so one bad link could cut a sweep short and make the
remaining offers look like they simply were not there.

### trailing · line 442

Splits the offer line: link | company | title | [location] | [y:N] |
[s:salary] | #id.
THE LOCATION IS READ TOO (audit 2026-07-31). It used to be thrown away
with everything after the title, so the weekly re-check could not apply
the geography rule at all: a country you had since switched off stayed
in your list for ever. It is the first trailing field that is not one of
the tagged ones, which is exactly how the scanner writes it.

### trailing · line 458

DAILY MODE (--liveness-only), asked for on 2026-07-08: "the bot will
have to verify DAILY that the links work and that the offer hasn't been
removed". It runs ONLY the dead/withdrawn check — Oracle API count=0,
Workday with no jobPostingInfo, HTTP 404/410, or "expired" text — over
every pending offer, and deletes the dead ones. No re-filtering and no
dedup: that stays in the weekly full run. Cheap enough for a daily cron.

### trailing · line 478

DELETES the line of each dead offer (before it was hidden with [x];
2026-07-18: that's noise), first leaving its URL in scan-history.

### trailing · line 500

SAME RULES AS THE SCANNER (audit 2026-07-25): housekeep used to read only
portals.yml while scan.mjs prefers config/profile.yml, so after editing
your profile the scan admitted offers under the new rule and the Sunday
cleanup deleted them under the old one.
The standing vetoes ride here too, so a veto taught after a "no"
clears its matching saved offers on the next cleanup — the same
promise the panel makes when it reports what still matches.

### trailing · line 516

GEOGRAPHY IS CHECKED ON BOTH HALVES, like the scanner (audit
2026-07-31). Only the TITLE was being tested here, so the offer's actual
LOCATION was never re-checked and a country you switched off after the
offer arrived kept it in your list for ever. The title check stays as
well, because multi-location postings hide the country there
("Graduate Programme - Qatar").

### trailing · line 535

SAME FALLBACK CHAIN AS THE SCANNER (audit 2026-08-08). This recheck
read only portals.yml's allow list and ignored the profile's declared
languages — so offers in a language the user works in, admitted
correctly by the scan, were deleted every Sunday and written to the
anti-repeat history: the project's only PERMANENT delete, applied by
the copy with the stale rule. The 2026-07-25 note above ("SAME RULES
AS THE SCANNER") set out to close exactly this class of drift and
missed the language list.

### trailing · line 552

Step 0c: EXPERIENCE and DEGREE filter — re-downloads the text of each
offer and hides the ones asking for more years than configured or requiring
a degree the user doesn't have. With the same text, the nuanced language
rule (2026-07-18): it doesn't matter which language the offer is
WRITTEN in; it's only hidden if the body REQUIRES a language the user does not speak.

### trailing · line 572

OrcaFlex exception (2026-07-11): if it mentions OrcaFlex, it's kept
even if it asks for more years — it's the user's star tool.

### trailing · line 576

DEGREE requirement in the body (2026-07-16): master's/degree in
a field the user doesn't have → out (same as in the scanner).

### trailing · line 594

KEEP THE NEWEST (audit 2026-07-25). It used to keep the FIRST occurrence,
i.e. the oldest line — and when a company re-posts a vacancy under a new
link, the old one is precisely the one about to be deleted as dead in
step 2, so the role vanished completely. We walk backwards instead.

### trailing · line 616

THE SAME BRAKE AS THE DAILY CHECK (audit 2026-07-31). This path deletes
strictly more than the daily one and had no brake at all: with a portal
answering 404 to everything, the daily run stopped with the list intact
and this one, seconds later, emptied it. Only the DEAD verdicts are
dropped — the filtered and duplicate ones are decided from text we
already hold, so a network problem cannot make them wrong.

### trailing · line 630

Final step: prepares the summary and, unless it's a dry run, DELETES from
the file all the filtered/duplicate/dead ones (before they were hidden with
[x]; 2026-07-18: that's noise). Their URLs remain in scan-history.

### trailing · line 670

Starts the process; if something fails completely, it prints the error and signals the system (exit code 1).
GUARD 2026-07-25 (audit): main() DELETES pending offers, and it used to run
just by importing this file — so any tool that imported it would silently
start deleting. It now only runs when launched directly, like scan.mjs.

## list-offers.mjs

### pendingOffers · line 46

Walks line by line through the format "- [ ] link | company | title |
[location] | [y:years] | [s:salary] | [#number]". Instead of a single
brittle formula, it splits on the bars and CLASSIFIES each extra field by
its shape (audit 2026-07-18: the previous trick failed when the
offer had no location and showed "y:2" as if it were the city).

## live-list.mjs

### refreshList · line 70

THE HEART: deletes the previous list and re-sends the updated list of
pending offers to the bottom of the chat. Options:
  alert   = true → the repost makes a sound (the scanner uses it for new
                   offers; this single list is the ONLY offer message, so
                   its ping IS the new-offers alert). Default silent.
  markSeen= true → YOU viewed the list (a command of yours), so the current
                   offers stop being "new". Offers not yet seen show [NEW].
It answers one of THREE things, and the difference matters to whoever calls it:
  null   → Telegram is not configured, so nothing was even attempted.
  false  → it tried and FAILED; no list reached your chat.
  number → it worked, and this is how many offers are pending.
It never throws: if something fails, it logs it but doesn't take down its
caller (scanner or listener).
`deps` exists so the ORDER below can be tested. It is the whole point of
this function and it cannot be checked from the outside: any test that only
looks at the final state passes even if the delete happens first, which is
precisely the bug fixed on 2026-07-25.

### refreshList · line 95

ORDER FIXED 2026-07-25 (audit): the previous list used to be deleted
FIRST. If the resend then failed (a 429 beyond the retry, a timeout),
you were left with NO list at all and a half-sent one orphaned in the
chat. Now we SEND first and delete the old one only once the new one is
safely posted: the worst case is two lists for a moment, never zero.

### refreshList · line 115

paged (2026-08-19): the whole list is ONE message showing a page,
with Prev/Next buttons editing it in place — a 60-offer list no
longer arrives as three stacked messages.

### refreshList · line 129

RECONCILED UNDER LOCK (audit 2026-08-08). Scanner, housekeep and
listener are separate processes and both used to work from the ids
loaded before their sends: whoever saved second erased the other's
freshly-sent list from the state without deleting it — a stale list
of possibly-dead offers orphaned in the chat for ever, the exact
artifact this module exists to remove. The lock covers only the
read-and-save milliseconds (never the sends); whatever the state
named at that instant joins the delete pile, so the loser's list is
swept instead of stranded.

### refreshList · line 147

FIX (audit 2026-07-31): SAY OUT LOUD THAT IT FAILED. This used to hand
back the offer count anyway, so the caller had no way to tell "the list
is on your phone" from "nothing was sent". The scan would then report
that Telegram was NOT SET UP, while those offers had already been
written into the pending file and into the anti-repeat history — so
they were never offered again, and you were never told about them once.
AND THE [NEW] TAGS SURVIVE: marking them seen recorded offers as shown
when the list never left the server, so the next one read as old news.

## liveness-core.mjs

### classifyLiveness · line 54

NO EVIDENCE = NOT DEAD (audit 2026-07-25). 404/410 are the only codes that
MEAN "gone". Anything we simply could not read (network failure = 0, a
server error, a 403 block, a rate limit) says nothing about the vacancy,
and the "insufficient content" rule further down would otherwise call it
expired and delete a live offer for good. Workday's 403 is handled
separately by housekeep, which knows that portal answers 403 when withdrawn.

## notify.mjs

### classifyLocation · line 136

WHOLE-WORD (audit 2026-07-25): these were plain substrings, so a location
like "Argenteuil" was filed under BELGIUM because it contains "gent".
The boundary uses \p{L} because JS's \b only knows ASCII ("België").

### compactTitle · line 187

Takes the NOISE out of a title and nothing else: contract parentheticals
("(Temp Agency)"), trailing acronym lists ("... DWDM / MPLS-TP / TDM") and
sector tags every offer here already carries ("- NAVAL Sector").
IT NO LONGER SHORTENS: a 72-character cut hit 41 of 1,006 real titles, and
Telegram wraps a long line by itself, so there was only a title to lose.

### compactTitle · line 198

Removes the trailing "acronym tail" (e.g. " DWDM / MPLS-TP / TDM").
Each slash-segment must start AND end on a non-space (CodeQL round,
2026-08-24): with spaces allowed at the edges, the split between the
separator's \s* and the segment was ambiguous and backtracking went
polynomial on titles that almost match — and titles are board input.

### cityOf · line 228

The "· reflotada" marker (from the amnesty, removed 2026-07-18 at the user's
request) still appears in old lines inside the location — it's stripped
here so it doesn't show up as part of the city name.

### cityOf · line 246

AND ON DISK ACROSS PROCESSES (audit 2026-08-08). The listener is a fresh
process every minute and the in-memory cache died with it, so every list
refresh — each `seen`, each `list`, each scan — re-translated the WHOLE
pending list through 1-2 Google requests per title: ~50-100 sequential
external calls to redo work already done. A title is now translated once
in its lifetime. Only real answers are persisted — a network failure must
stay retryable, or a French title would stay French for ever.

### downloadTelegramFile · line 408

Downloads a file the user sent to the bot (getFile, then the file API).
Exists for the CV question: people send the PDF they already have, not
pasted text (field test 2026-08-06). Returns a Buffer, or null when the
file is missing, oversized (bots can fetch up to ~20 MB; a CV is under 2)
or the network fails — the caller owns the apology.

### deleteTelegramMessage · line 438

Telegram refuses to delete a message older than 48h. Say it once in the
log instead of failing mutely, so a list that stays in the chat has an
explanation (audit 2026-07-25).

### editTelegramMarkup · line 494

Redraws ONLY the keyboard under a message (2026-08-23). editMessageText
resends the whole text on every multi-select tick, and that round trip was
most of why ticking an option felt slow.

### clearTelegramButtons · line 510

Takes the keyboard OFF a message a flow is finished with: dead buttons
left on closed questions kept being tapped (field test 2026-08-23).

### offerAffinity · line 527

Affinity score of a title (2026-07-18): +2 if it's one of the user's fields
(mooring/offshore/survey...), +1 if it's junior/graduate. Used ONLY to
order the display — never to filter. Exported so it can be tested in
test-filter.mjs.

### offerAffinity · line 536

(The inline BUTTONS under each offer were tested on 2026-07-18 and the user
removed them that same day: the owner prefers typing the commands. Do not reintroduce them.)

### offerAffinity · line 539

NAVIGATION buttons are different, and owner-requested (2026-08-19): a long
list arrives as ONE message showing a page, with Prev/Next flipping the
page IN PLACE (editMessageText) instead of stacking messages in the chat.
Per-offer action buttons remain vetoed — this row only turns pages.

### listPageKeyboard · line 545

Since 2026-08-22 the list also carries ONE action row: the entry to the
review mode (review.mjs), where the per-offer buttons live on a card that
shows a single offer — the only place a button can say which offer it
belongs to. The list itself still gets nothing but navigation.

### councilVerdicts · line 615

blind → [?]: the page gave the judges nothing to read, so nobody voted.
It must not look like a YES (2026-08-26): fed a cookie wall, two judges
defaulted to show and the list said YES to an offer none of them had read.

### flush · line 673

The list is BUILT first as pages and SENT after (2026-08-19). Building
and sending used to be one interleaved loop; splitting them lets the
same builder feed both renderings — every page as its own message (the
old behavior), or one paged message with Prev/Next buttons.

### addGroupHeader · line 700

Order by affinity (2026-07-18, approved improvement): within each
country, what's "most yours" on top (the user's fields +2, junior/graduate
+1). It only changes the visual ORDER — it doesn't filter or hide
anything; on equal affinity the arrival order is kept (Node's sort is stable).

### addGroupHeader · line 707

Build the offer line: title - company - city (the city is omitted if
it just repeats the country), with the offer number in front. Since
2026-07-18, if known, the required years and the salary are added
("~" = Adzuna estimate, not data from the posting).

### addGroupHeader · line 753

Buttons on every list since 2026-08-22, single page included: a short
list has no page row, but the review entry is always there.

### cliSetup · line 794

WAIT for the message instead of demanding it already arrived (field test
2026-08-03): the user sent their message and pressed Enter within a
second or two, the single getUpdates came back empty, and the dead end
forced them to restart the whole setup. Telegram can lag a few seconds,
so this polls — up to two minutes, stopping the moment it appears —
before declaring nothing there. The wait costs nothing when the message
already arrived: the very first look finds it.

### cliSetup · line 804

THE LISTENER MAY HAVE LINKED THE CHAT MEANWHILE (field test
2026-08-05): once any listener polls this bot — a scheduled one from
this install, or a survivor of an earlier one — it CONSUMES the very
message this poll is looking for, so waiting on getUpdates alone
waited for ever. telegram.json is the meeting point: the listener
writes the chat_id there and this console run only has to notice.

### cliSetup · line 818

Telegram answers a bad token two different ways, and both mean the
same thing: 401 Unauthorized when the token is well-formed but wrong,
404 Not Found when it is not even token-shaped. Saying so plainly is
the whole point — the raw error used to send people looking for a
problem with their chat, when the token was simply mistyped.

### withChat · line 847

Atomic (audit 2026-08-08): a crash mid-write corrupts the ONE file
holding the token and the bot goes mute until the setup is re-run.

## offer-body.mjs

### fetchOfferPage · line 9

Depending on the link's portal, it requests the offer text via the
right route (Workday and Oracle have their own "data gateway"; LinkedIn
has a public version; Adzuna is read from its details page). If nothing
matches, it downloads the page as-is and strips the HTML.
Returns { text, status }: the text, and the HTTP status of the request
that decided it — 0 when no answer came at all (timeout, DNS, refused).
The status matters to the Council (2026-09-01): Adzuna answers a burst
with 429 and CloudFront with 403, and an empty text that means "come back
later" must not be judged like a page that has nothing to say.

### fetchOfferBody · line 54

Just the text, for readers that do not care why it may be empty.
(Exported 2026-07-18; used by the amnesty, deleted that same day at the
user's request — the export stays in case another module needs it.)

## onboarding.mjs

### backupBeforeOverwrite · line 55

Countries offered as buttons. Each carries the display label and (when it
exists) the Adzuna domain code, so the written profile is complete.
aliases = the country's NATIVE spellings, emitted into locations.allow
(audit 2026-08-08). The allow gate is a plain substring test with no
translation, and offers arrive written in their own language —
"München, Bayern, Deutschland" contains no "Germany", so for onboarded
users nearly every native-spelled location died at the gate in silence
(the FR/DE-blocked-for-days incident portals.yml already documents).
Full names only: the substring match makes short codes ("ES") unsafe.

### backupBeforeOverwrite · line 91

Degrees offered as buttons → the regex fragment written to degrees_excluded.
Each value carries the native spellings too (#798, 2026-08-05): "mécanique"
ends in -que, "électrique"/"Elektrotechnik" open with é/elek, and the
German and Dutch names for whole majors were simply absent from the stems.

### cvDegreesHeld · line 154

What the CV itself can tell the setup — no LLM anywhere, the same
rule-based route the open-source resume parsers use, with the buttons as
the human confirmation that absorbs any imprecision (2026-08-23, after a
field test ran an accountant's CV into marine-flavoured questions).
Degrees: the catalog's values are ALREADY multilingual regexes (the same
stems the offer filter matches), so the CV is tested against the very
definition of each family — one source of truth. A family the CV shows is
NOT pre-ticked as excluded; everything else is. Over-detection merely
leaves one more tap to the user, and under-detection one tap the other
way: a default, never a decision.

### foldLetters · line 203

Institutions and companies wear name-shaped clothes too (field case
2026-08-23: "Universidad Argentina del Comercio" won the shape test).

### cvContact · line 268

The contact block, straight off the CV (field case 2026-08-23: the bot
asked for an email the document had just printed). Email is a regex;
a phone needs nine digits or a +/( opening, so the year range
"2014 – 2018" — eight digits with a dash — can never pass for one; the
city is the early "Place, Country" line: comma-separated capitalised
words with no digits and no trade/org words. Any piece can be missing.

### cvProfileSuggestions · line 381

The full CV reading (2026-08-23): skills stay local; the skills are then
matched to ESCO occupations, whose labels become ROLE suggestions and
whose ISCO areas pick which DEGREE families the question should even ask
about. Every area the CV shows contributes — a person who was accountant
AND salesman gets both, because either could be the job they actually
want. No network, or ESCO knowing none of the terms, degrades to the
offline suggestions — never an error, never a guess.

### lookup · line 398

Breadth first (measured live 2026-08-23): one label from EVERY
occupation before any second one — the first profession's synonyms were
eating all eight slots and the CV's OTHER trade never appeared. The
singular/plural fold keeps bookkeeper/bookkeepers twins out.

### prompt · line 507

CV-informed defaults (2026-08-23): the degrees list arrives pre-ticked —
excluded — for every family the CV shows no sign of, and the fields
question carries the CV's own skills as a one-tap suggestion. Defaults,
never decisions: the user confirms every tick.

### prompt · line 515

The options RIDE WITH the answers (audit 2026-08-23): a later settings
edit rebuilds its state from the saved answers alone, and without this
the keyboard fell back to the shipped catalog — wrong ticks, and the
CV-picked families unreachable for ever after.

### prompt · line 537

SEND FIRST, persist AFTER (audit 2026-08-08). The state used to be saved
before the prompt went out, so one failed Telegram send left the file
pointing at a question nobody ever saw — and the next thing the user
typed was silently recorded as its answer. Failing before the save just
re-asks the same question, which is harmless.

### prompt · line 547

The optional question carries its way out as a button (owner,
2026-08-23). Typing "skip" still works; typed text still answers.

### hasRealCv · line 559

`/start` → begin the full setup from question 0.
IT ASKS FIRST IF YOU ALREADY HAVE A PROFILE (audit 2026-07-31). Question 0
is "paste your CV", and the listener hands any text you type to the setup
BEFORE it looks for a command — so with the setup already running, typing
"list" wrote the word "list" over your entire CV. There was no confirmation,
nothing to cancel with, and cv.md is the only copy: it is what your cover
letters are built from. `settings` already refuses to run without a profile;
this is the same guard pointing the other way.
Is there a CV worth protecting? The shipped file is a placeholder, so its
presence alone means nothing — a real one is longer and does not say so.
(Ported from the personal copy 2026-08-23: its own test suite caught this
guard missing during a merge, which is how the public copy learnt of it.)

### startSettings · line 613

Every question, the CV included: replacing it is the whole point of being
able to edit one field. (This was written as a filter that filtered
nothing, which reads like a rule and is not one.)

### parseContact · line 631

Reads the contact answer by the SHAPE of each piece, not its position
(field test 2026-08-23): the email is the part with an @, the phone the
part that is digits, and whatever remains is the city — in any order, any
of them alone. The old positional read put "Barcelona, mail@x" city-first
into the email slot and fed the search a phone number as the home city.

### applyContactAnswer · line 674

Say ONCE what was understood and what is absent — the old flow took
"just an email" and marched on in silence, and the city it lost is
what the cover letters and the home-city search group run on. One
round, never a nag: the second answer (or Skip) always moves on.

### handleOnboardingDocument · line 749

Handles a DOCUMENT while the setup waits for the CV: users send the PDF
they already have, not pasted text (field test 2026-08-06). Only the CV
question consumes files; anywhere else the document is left unanswered
and the question on screen still applies. Returns true if consumed.

### handleOnboardingCallback · line 813

BOUND TO ITS MESSAGE (field test 2026-08-23), like the list pages and
the review card already are: a tap on an already-closed question used to
land on the CURRENT one — same o:N data, same button positions — so
re-ticking the finished degrees list ticked France and Germany on the
countries list. A tap whose message is not the live question only gets
a toast.

### handleOnboardingCallback · line 876

Keyboard-only edit (2026-08-23): editMessageText resent the whole
prompt on every tick and was most of why ticking felt slow.

### advance · line 902

No saveState here (audit 2026-08-08): askCurrent persists AFTER the
prompt is delivered — saving the advanced step first was the bug.

### quote · line 930

Quote values YAML could misread (regex fragments, leading symbols) with
SINGLE quotes: unlike double quotes, YAML does NOT process backslash
escapes inside them, so "deutsch\w*" survives verbatim. A literal single
quote inside is doubled ('').
NOTE: newlines (\n, \r) are in the trigger set too — a value pasted across
two lines used to be written unquoted, which broke the whole YAML file and
silently reverted every filter to the built-in defaults.

### buildProfileYaml · line 954

Contact, structured first (2026-08-23): the onboarding now stores what
each piece IS, so nothing here depends on the order the user typed.
The positional split stays as the fallback for answers saved before —
every settings edit regenerates this file from the old record.

### buildProfileYaml · line 963

AN EMPTY LIST OF ROLES SWITCHES THE TITLE FILTER OFF (audit 2026-07-31).
An answer that is only spaces or only commas comes out as [], and the
title filter reads an empty positive list as "no keyword required" — so
every job title in the world passes and the only thing left between you
and the entire market is the deal-breaker list. That is the opposite of
what a blank answer means. So when there is nothing usable the key is
left out of the file altogether and the rules already in force stay.

### buildProfileYaml · line 971

WHAT TO SEARCH FOR, WHEN THE ROLES ANSWER GAVE US NOTHING USABLE
(audit 2026-08-01). A punctuation-only answer reduces to an empty list,
and neither obvious option is right: writing [] tells the scanner no
keyword is required, so every title in the world passes; leaving the key
out makes it fall back to portals.yml, whose list is the shipped MARINE
example — so an accountant's bot would ask the boards for accounting jobs
and then reject every one of them for having "no keyword from your
field", for ever, without a word.
The fields answered two questions later ARE the user's own, so they are
what the filter falls back to. A worse filter than a proper list of
titles, but about the right line of work, which is the part that matters.
Fields become regexes downstream, so each typed word is escaped to match
literally (roles do NOT need it — scan.mjs escapes title terms itself).

### buildProfileYaml · line 1007

Name AND native spellings (audit 2026-08-08): the allow gate compares
substrings with no translation, and offers name their country the way
the posting's own language does.

## pipeline-format.mjs

### (module level) · line 2

WHAT IT IS: the two headings that divide data/pipeline.md — the offers
waiting for you, and the ones already dealt with.

WHY IT IS A FILE OF ITS OWN. Four modules need them: the scanner writes,
the list reads, "seen" edits and housekeep deletes. Each used to spell
them out for itself — four copies of one decision, which drift the moment
anybody changes one of them. One place, one spelling.

CHANGING THEM MEANS CHANGING YOUR FILE TOO. data/pipeline.md already on
disk carries the old heading, and a heading that stops being recognised
does not raise an error — the list simply comes back empty, which tells
you nothing about why. Rename the file at the same time, and keep a copy.

## requirements.mjs

### escapeRegex · line 37

Config list -> one case-insensitive regex. A term may be a pattern (what
the onboarding writes: "m[eé]c[áa]ni[ckq]") or plain text typed by hand
("C++", "Node.js"). Whatever does not compile as a pattern is taken as
plain text — escaped, and said so on stderr — instead of dropped: "C++"
used to vanish in silence, and the profile it was meant to guard had a hole.
An EMPTY list means "filter OFF" (NEVER_MATCH); a MISSING key means "not
configured" and only then do the marine defaults apply — before the
2026-07-25 audit both fell back, so emptying a list restored the defaults.

### profileRegex · line 65

The word "years" in the 6 languages. The closing \b is added where it is
used, so French "an(s)" can't fire inside "analyst"/"and".
Audit 2026-07-25: the Catalan singular "any" was removed and the plural
made strict ("anys") — it collided with the English "any", and "3 any of
the following ... experience" was read as a 3-year requirement.

### profileRegex · line 76

Requirement VERBS, an alternative gate to EXP: "the role requires 5+ years
in WMS projects" never says "experience" but clearly asks for years (real
case #528 that slipped through, 2026-07-11). The NEG guard below still
protects against false positives.

### profileRegex · line 90

Finds "number + years", ranges included ("3-5 years", "3 a 5 años", "2 or
5 years"), and keeps the LOW end. ("or"/"o" added 2026-07-18: "2 or 5
years" was read as 5.) The (?<!\d)…(?!\d) keeps the number a standalone
1-2 digit integer, so GE's "building on over 130 years…" can't match "13".

### profileRegex · line 95

(?:[.,]\\d+)? = DECIMALS (audit 2026-07-25). Without it "1.5 years of
experience" failed at the "1" and the scanner matched the "5" instead,
reading FIVE years and dropping a junior offer.

### profileRegex · line 101

(Audit 2026-07-18: "3 or more years" / "3 o más años" didn't match at
all — the "more/más" between the number and "years" broke the pattern
and the requirement went unnoticed. Now it reads as 3.)

### profileRegex · line 105

── Numbers written as WORDS (2026-07-22, case #653: the NL offer
"Minimaal vijf jaar" = 5 years slipped through) ─────────────────────
The detector above only reads DIGITS, so a requirement spelled out ("vijf
jaar", "fünf Jahre") went unnoticed. We translate those words to their
digit BEFORE searching, and everything above keeps working unchanged.
Word→digit map (0-15) in the 6 languages. Unique keys; when the same
spelling exists in two languages with the SAME value, it goes only once.

### profileRegex · line 120

Catalan "set" (7) removed 2026-07-25: "a broad skill set years in the
making" was read as SEVEN years.

### profileRegex · line 126

Spanish "once" (11) removed 2026-07-25: a very common English word.

### normalizeSpelledYears · line 154

2026-07-18: "if it demands it, drop it; if it says nothing or says it is
NOT required, keep it — silence benefits me". These four guards are checked
in the number's own SENTENCE, so a "valorable" elsewhere cannot cancel a
real requirement.
(1) NEGATED: "you don't need 5 years", "brauchen keine 5 Jahre".

### normalizeSpelledYears · line 164

(4) DURATION of the JOB, not of your past: "contrato de 2 años". Only
counted ATTACHED before the number. Widened 2026-07-25 — it caught only
"contract of 3 years", so "a 2-year assignment" still dropped good offers.
The filler words carry their own \s INSIDE the repetition and "de" is
spelled once, not twice (CodeQL round, 2026-08-24): the old form repeated
bare alternatives with two of them matching the same text, which is the
recipe for exponential backtracking on a near-miss — and this regex runs
against a window of every advert body.

### guardZone · line 176

Audit 2026-07-18: the guards read the segment BETWEEN COMMAS around the
match, not the whole sentence — a "preferred" about another topic used to
cancel a real requirement. Plus the previous segment when short ("Ideally,
4 años…") and the next one always ("5 años, aunque no imprescindibles,…").
A softener that opens the NEXT segment and then names a FIELD ("…, ideally
in offshore wind", "…, preferably in the maritime sector") modifies the
field, not the requirement — yet it used to cancel a firm "5 years" the
segment before (audit 2026-08-08). Softener + preposition = about the
field → that segment stays out of the guard zone. A bare ", preferred" or
", aunque no imprescindible" still cancels, as it should.

### collectYearHits · line 207

Lowercases the whole text, unifies spaces and translates years written
as words to digits ("vijf jaar" → "5 jaar"), so the rest of the
detector sees them the same as "5 jaar". Typographic apostrophes fold
first (audit 2026-08-08): NEG_YEARS's "don'?t" can't see U+2019, so
"You don’t need 5 years" was read as a firm 5-year requirement — the
same bug degreeScreen already fixed for the Heerema master's.

### collectYearHits · line 224

Needs an "experience" word or a requirement verb beside the number, and no
company boast; anything less is not counted and the offer is KEPT.
The boast check reads the WHOLE SENTENCE (audit 2026-07-25): the giveaway
comes after the comma — "With 25 years of experience…, Acme is your
partner." — and fell outside the ±50 window. The negated/softened checks
below stay bound to the comma segment on purpose (r30).

### collectYearHits · line 235

Guards 2026-07-18: if the number's own segment negates or softens the
requirement, it does not count and the offer stays.

### multiYearScreen · line 282

"SEVERAL years" with NO number (2026-07-19, case Sartorius #632: the German
"mehrjährige Berufserfahrung" carried no figure, so the check above
returned nothing). Asking for varios/several/mehrere years of experience
means at least 3, over the default threshold of 2. Only forms attached to
"experience" in 5 languages, with the same negated/soft guards.
German noun phrasing added 2026-08-08: "mehrere Jahre Berufserfahrung" is
as common as the adjective "mehrjährige" and slipped through — Dutch always
had both forms ("meerdere jaren" / "meerjarige").

### multiYearScreen · line 302

Company boasts too (audit 2026-08-08): "Thanks to our many years of
experience, we are a leading provider…" matched MULTI_YEARS and dropped
junior offers — the numbered path always consulted NEG (the boast
list); this path never did. Whole sentence, same as there.

### experienceScreen · line 315

THE VERDICT (2026-07-13, case #527 "2 años en un puesto similar" on a PLC
offer): how many years they ask for is not enough — you have to look at IN
WHAT. More years than the threshold → out; 1-2 years but "in a similar
role" or in a technology the user has at zero, with neither context nor
title in their fields → out too (they can't back them up); generic years →
kept; no clear years → kept.

### experienceScreen · line 323

"several/mehrjährige years" is checked ALWAYS (audit 2026-07-25). It used
to be skipped whenever ANY number appeared, so "1 year with Excel.
Several years in the field required." was scored as 1 and let through.

### experienceScreen · line 339

2026-07-16: offers with a clean title (Project Engineer) often demand in
the TEXT a degree the candidate lacks. "degree/master's/bachelor" in 6
languages — but NOT "ingeniería", which in Spanish names the degree AND the
discipline and fired on "5 años de experiencia en ingeniería mecánica".
"opleiding" is how Dutch postings say it ("afgeronde hbo-opleiding..."):
without it the whole Dutch demand was invisible, majors and all.
Two dead stems revived 2026-08-08: "licenciatur" could never match
"licenciatura" (the trailing \b landed mid-word), and German/Dutch
COMPOUNDS ("Bachelorabschluss", "bacheloropleiding", "Bachelorstudium")
were invisible to the standalone words — masterabschluss was covered in
MASTER_DEGREE, the bachelor/generic path was not. \w* on both sides of
the compound heads closes the family.

### experienceScreen · line 352

Named majors the user does NOT have: if the requested degree is only these
and names none of their fields, the offer is impossible for them. In the
marine example "industrial" and "civil" only count next to "engineer/génie"
— industrial AUTOMATION is in scope. The accent is folded ("el[eé]ctr[io]")
because plain "electr[io]" missed "eléctrica" and let a degree through.
THE NATIVE SPELLINGS NEVER MATCHED (#798, 2026-08-05): "mécanique" ends in
-que where the stem demanded -nic, "électrique" and "Elektrotechnik" open
with é/elek where the stem demanded "elec", and the German and Dutch names
for whole majors (Maschinenbau, Werktuigbouwkunde, Bauingenieur, Chemie,
Raumfahrt) were simply absent. Stems now carry every language the boards
actually write in.

### DEGREE_TITLE_SAFE · line 369

For each "degree" word, read the ~60 chars after it (where the majors are
listed): a major they lack with none of their fields nearby = impossible,
out. It never acts on titles from their field or their skills — 2026-07-16:
"even if it's not from my field it may interest me, e.g. automation
engineer junior" — so it only cuts generic and clearly unrelated titles.

### DEGREE_TITLE_SAFE · line 376

DEGREE GUARDS (2026-07-18, over-block hunt: "if it demands it, drop
it; if it doesn't state it or says it's NOT required, keep it"). Before,
ANY mention of a degree the user doesn't have discarded — even if the offer
said it wasn't needed, that equivalent experience works, or that the
degree is the FOUNDER's. Four guards, looking at the degree's SENTENCE:
(1) NEGATED DEGREE: "a degree ... is not required", "no se requiere titulación"...

### DEGREE_TITLE_SAFE · line 386

(3) ALTERNATIVE PATH ("or equivalent experience"): the degree is not a hard
barrier. Two levels (audit 2026-07-18): any form inside the degree's own
segment, but only unambiguous ones in the NEXT sentence — an "or equivalent
support" from a relocation line used to cancel a real degree.
The French way out has more shapes than "ou expérience équivalente": a real
posting wrote "ou dans une discipline équivalente" (#798) and the rescue
missed it. One clause covers the family: "ou [dans une] [discipline/
formation/diplôme/filière] équivalent(e)".

### DEGREE_TITLE_SAFE · line 400

2026-07-19 (P&G #627/#630): no master's held, so a firmly required one
always discards — the 07-16 exemption covered unrelated MAJORS, not a study
level. Saved if the sentence also accepts a bachelor, or on the usual
guards. FIXED 2026-07-25: accent-folded `m[áa]ster` also hit the English
word ("Harbour Master"), so only "máster" or "master + degree word" count.

### degreeScreen · line 433

Order matters. The master's rule goes FIRST, piercing every title
exemption (own-field included, 2026-08-06 #808: "Marine Surveyor" wearing
"Education: Master's Degree in Naval Engineering" reached the phone):
a FIRMLY required master's is impossible whatever the title says, and
the rule already stands down for a bachelor alternative, a softener or
an equivalence clause. Own-field titles remain exempt from the MAJORS
scan below — there the false drop is the expensive one.

### degreeScreen · line 447

2026-07-18: the degree's SENTENCE is computed first and both windows are
clipped to it. They used to cross full stops: "Bachelor degree required.
...mechanical systems on site" read that "mechanical" as a required major.

### degreeScreen · line 454

field escape: the WHOLE sentence (audit 2026-07-25). It used to be a
±40/90-char window, so in a normal list of majors — "Bachelor degree in
Mechanical Engineering, Electrical Engineering, Industrial Engineering,
Naval Architecture or a related field" — the user's OWN discipline sat
beyond the window and the offer was dropped even though it was listed.

### degreeScreen · line 461

Guards 2026-07-18 on the degree's own segment: negation, softening or
third person. A guard skips this mention; the rest of the text goes on.

### extractAdzunaJd · line 474

Pulls ONLY the offer's description out of an Adzuna page (it lives in
<section class="adp-body">). The rest of the page is menus and related ads
in the country's language, so without this the body-language check was
useless on Adzuna (10 rejections "it's all in French", 2026-07-13).
Returns '' if the marker is absent — the caller then skips the check.

### extractAdzunaJd · line 481

Note the `[^<>]` (not `[^>]`) in every tag pattern here: a tag can only
be read up to the next angle bracket of ANY kind. With the looser `[^>]`
a single stray "<" in the page — an unescaped angle bracket typed into
the ad, a tag someone forgot to close — let the pattern run straight past
the tag it was reading and swallow whatever came after it, so the body
handed to the years and degree checks was cut short or wrong and the
offer sailed through unfiltered.

### extractAdzunaJd · line 490

Audit 2026-07-16: count nesting instead of stopping at the first
</section>, or a nested one truncates the body. Latent today, correct if
Adzuna changes.

### stripHtml · line 504

HTML → plain text for the screens, on a real parser. This used to be a
chain of regexes, and regexes cannot parse HTML: CodeQL found three ways
past them in two days (a nested comment, "--!>" as a comment end, junk in
a closing tag), each a shape a browser accepts and a pattern did not. The
parser knows the shapes; what stays here is the SENTENCE rule the screens
depend on and the whitespace discipline.
The one deliberate difference: named entities now become their character
("&eacute;" → "é") instead of a space, so an accented word in an advert
survives whole — the old behaviour cut "exp&eacute;rience" into two words
the requirement regexes could not read.

### stripHtml · line 515

Each </li> ends a sentence (2026-07-18). Bullets carry no final stop, so
flattened they merged into one sentence and an "is a plus" from the next
bullet cancelled a real requirement (case WtbE). ONLY </li>: doing it to
</p> broke the softening of a "Nice to have:" heading.
"--!>" ends a comment in every browser (CodeQL #9); the parser only
knows "-->", and would otherwise read the rest of the page as comment.

### stripHtml · line 547

"5&#160;years" hid the requirement while the no-break space was not a
space to the regexes (audit 2026-07-25).

## review.mjs

### (module level) · line 3

WHAT IT IS: the "review" mode — the pending offers one CARD at a time,
with buttons instead of typed commands (owner-approved 2026-08-22 after
a mockup; the 2026-07-18 veto on buttons stays for the LIST, where a
keyboard under 25 offers cannot say which button belongs to which line).
ONE message is the card; every tap edits it in place, so the chat stays
clean. Decisions run the SAME actions as the typed commands — same
records, same honesty checks — injected by the listener; the card itself
is the confirmation, so no extra message lands in the chat.
EVERY DECISION IS REVERSIBLE, in three layers: the decided card keeps an
Undo button; older decisions are reachable by navigating back to their
card; and "undo N" works typed, any time, card or no card. Undo restores
the pending line AND removes the record the decision wrote (feedback or
application), so a slip of the finger cannot poison the learning data.

### loadJson · line 44

What the card SAYS about each decision: one word. Icons were tried on
buttons and states (2026-08-22) and the owner pulled them the same day —
plain labels only, and bare arrows.

### reviewCardText · line 70

The card's text: two lines for a pending offer, a struck title and one
word for a decided one. Everything shown comes from a job portal or from
the pipeline, so it is escaped — a title with "<" must not kill the card.
The Council's word rides the title line exactly as it does on the list
([YES]/[MYB]/[NO], field find 2026-08-25: review shipped without it) —
and only on the PENDING card: a decided one is a receipt, the advice
already did its job.

## scan.mjs

### (module level) · line 49

EXPERIMENTAL (2026-08-24): the standing vetoes the user taught by tapping
after a "no". Merged into every filter below so a veto behaves exactly
like a hand-written negative.

### normalizeLocation · line 162

NOT A DISPLAY WIDTH. A 70-character cut used to go into pipeline.md, where
housekeep re-reads the location weeks later to apply the country rule: 35
of 993 were cut, and a country named last in the string simply vanished.

### normUrl · line 168

Simplifies a web address so it can be compared: it removes the tracking
"tail" that changes on every visit. Without this, the same Adzuna offer
would look new on every scan. Also (2026-07-18): Adzuna's
/land/ad/<id> bounce and its /details/<id> page are THE SAME offer,
so for comparison they are both mapped to /details/<id> — without this, the switch
to /details links would have made "new" every offer already seen.

### parseGreenhouse · line 249

THE ADVERT TEXT COMES ACROSS TOO (audit 2026-07-31). These three parsers
kept only the title, link, company and place, so fetchOfferDescription had
nothing to hand back and the years, the degree and the body-language screens
all ran against an empty body — every offer from these boards walked
straight through, unread. All three send the text along with the list, so
reading it costs no extra request. Greenhouse only includes it when the URL
asks for it, which is done in greenhouseUrlWithContent below.

### collectWorkday · line 427

DID THIS BOARD ANSWER AT ALL? (audit 2026-07-31) Every request error used
to be swallowed and an empty list returned, so a board that could not be
reached looked exactly like one with no matching jobs. Measured with the
network cut: nine boards reported as scanned, five errors, and seven
failures invisible — the run read as an ordinary quiet one.

### collectOracle · line 545

Same as Workday above (audit 2026-07-31): a board that never answered is
a failure to report, not an employer with nothing on offer.

### collectOracle · line 560

Free API: https://developer.adzuna.com/ — credentials in
server-bot/adzuna-key.json or env ADZUNA_APP_ID / ADZUNA_APP_KEY.
One request per (enabled country × query). Failures are COUNTED and
surfaced (they used to be silent — that hid real outages).
Adzuna is an aggregator: a search engine that gathers offers from many
portals (Indeed and European job boards). It's queried for each
combination of enabled country × configured search.

### k · line 595

Audit 2026-07-18: if the API came with min>max, it's reordered (before,
a nonsensical range like "€80-20k" came out).

### adzunaDetailsUrl · line 604

Adzuna translator to the common offer format. It also saves the
short description snippet, which later serves the years-of-experience
filter without having to make another request — and the SALARY
(2026-07-18, approved improvement: it came free in the same response and was
thrown away; now it's shown on Telegram).
Adzuna sometimes gives the "good" link (/details/<id>: ITS page, where the
offer is READ) and other times a tracking BOUNCE (/land/ad/<id>) that dumps you
on the advertiser's form (in Germany, XING) without letting you read anything
(the user's real case, 2026-07-18). Here the page is ALWAYS forced,
built with the posting id over the country's domain.

### parseLinkedInCards · line 721

These three lines extract title, company and location by looking for
the tags LinkedIn uses to mark each piece of data on the page.
THE "REST OF THE TAG" PART IS BOUNDED (audit 2026-07-31). It used to be
"anything that is not a >", which happily runs across the rest of the
document looking for a closing bracket that a malformed or hostile page
simply never provides — and then backtracks over all of it, once per
card. Measured on a page built to provoke it: 43 seconds for 500 KB, and
the whole scan sits there waiting. Forbidding "<" as well means the
search cannot leave the tag it started in, so a bad page costs a missed
field instead of the run. Real LinkedIn markup matches exactly as before.

### collectLinkedIn · line 753

Are we in a penalty period for having received a "429"? Wait.
A COOLDOWN CANNOT BE LONGER THAN A COOLDOWN (audit 2026-07-31). The rest
is stored as an absolute moment, so one excursion of the machine's clock —
a dead battery, a bad time sync — writes a date months away, and after
that LinkedIn stays switched off until then with nothing said anywhere.
Anything further ahead than the cooldown length is not a cooldown, it is a
wrong clock, so it is ignored and said out loud.

### maxAgeSec · line 814

--dry-run must touch NO file (audit 2026-07-25): this one slipped through
and a dry run silently moved the LinkedIn cursor forward.

### maxAgeSec · line 820

"ran" used to cover every outcome short of a 429, so a LinkedIn that
answers 403 to every call — a permanent block — read exactly like a
healthy run with no matches. Refusals and total silence say so now.

### overrideDeadIfApply · line 848

Anti-false-dead second opinion (caught 2026-07-18): the system's
classifier marks "expired" if ANY chunk of the page contains phrases
like "position has been filled" — even if they come from a widget of OTHER
offers or from generic text, and even if the page has a
perfectly live apply button. The user's rule: losing a good offer is
the expensive mistake. So: if the "expired" verdict comes from a PHRASE in the
text (not from a 404/410 or a redirect, which are hard proof) and
the page still has an apply signal → it's considered LIVE.

### overrideDeadIfApply · line 857

Audit 2026-07-18: the second opinion only applies to the GENERIC
patterns ("applications closed", "closed on <date>" — the ones that can
come from a FAQ or a holiday notice). The emphatic ones ("position has
been filled", "no longer available/accepting", "job has expired") are almost
always THIS offer's banner: an "Apply Now" from a widget of
similar offers must not revive them.

### deadFromEvidence · line 871

The verdict on evidence already in hand, split out (audit 2026-08-08) so
the liveness step can judge from the page the experience screen ALREADY
downloaded instead of fetching the same URL a second time.

### scanPoliteFetch · line 916

Slot allocator per host, not a last-request timestamp (audit 2026-08-08).
The old check-then-act — read the timestamp, sleep, write — let the five
callers of parallel(checks, 5) compute the same wait from the same base,
wake at the same deadline and fire TOGETHER: the 1.5 s gap became bursts
of 5, and the 429s those bursts provoke are what defer offers to the next
scan. Claiming the slot synchronously (no await between read and write)
hands each concurrent caller its own moment, one gap apart.

### scanPoliteFetch · line 942

15 s penalty after a 429 (previously 8 s: it fell short and the 3
attempts died within the same rate-limit window).

### fetchOfferDescription · line 955

A body some earlier step already extracted wins outright (audit
2026-08-08). The sitemap parser stores the whole JD in _jd and the
Workday location enrichment now stashes it too — yet this function
fell through to o.description, which is EMPTY for sitemap offers, so
Van Oord and Boskalis skipped the years/degree/language screens
entirely — the same failure class fixed for greenhouse/ashby/lever.

### fetchOfferDescription · line 1029

Status + page stashed for the liveness step (audit 2026-08-08):
it used to re-download this same URL minutes later — a second
full pass over the host whose 429s defer offers, and without the
1.5 s pacing.

### fetchOfferDescription · line 1035

429 exhausted or network down: the body could NOT be read. It's flagged
to DEFER the offer (real case #626/#627, 2026-07-18: without
this flag they went to the list half-examined).

### fetchOfferDescription · line 1066

Titles that state the working language outright: "(German or French
speaking)", "Dutch-speaking Support Engineer" (#116, 2026-07-10). It looks
for a language name closely followed by "speaking" or similar — no API
call, fully deterministic. EN/ES/CA are the languages of the profile; any
other named language in the title is a requirement that can't be met.

### titleEncodingBroken · line 1087

Broken-encoding detector (field case 2026-08-22): Adzuna delivered
"Automation Engineer ??????" — the non-Latin half of the title destroyed
upstream and replaced by literal question marks — geotagged France,
actually a Shanghai job. A run of ??? (or any U+FFFD) in a title can only
be a portal mangling text it could not encode, and the mangled half is
precisely the half naming the real language or place. No legitimate title
carries either, so this drops nothing real.

### titleEncodingBroken · line 1098

BODY LANGUAGE RULE (refined by the user on 2026-07-18): the language in
which the offer IS WRITTEN no longer matters (a Dutch offer that doesn't
ask you to speak Dutch can be good). What DOES discard it is the
body REQUIRING a language the user doesn't speak: "fluent in German",
"Deutschkenntnisse erforderlich", "talen: Nederlands"... And note: if nearby
it says "is a plus" or "valued", it's NOT blocked (it's not mandatory).
List of languages the user doesn't speak (German, French, Dutch...),
written as a search pattern with its variants in several languages.
Built from your profile (config/profile.yml → search.languages_blocked);
the marine default below (German/French/Dutch...) is used if it's missing.

### titleEncodingBroken · line 1111

Words that indicate a requirement: "fluent", "required", "imprescindible",
"se requiere", "erforderlich", C1/C2 levels, "native"...
2026-07-27: the German and French ways of saying it were missing, so every
German offer walked through. Real sentences that escaped: "Deutsch und
Englisch fließend in Wort und Schrift" (#697), "Sehr gute Deutsch- und
Englischkenntnisse" (#719), "Verhandlungssichere Deutschkenntnisse" (#699).
Note "gut\\w*" is only ever read NEXT TO a language word, so "gute
Excel-Kenntnisse" alone cannot fire it.

### titleEncodingBroken · line 1130

"Softener" phrases: if they appear nearby, the language is only desirable
("a plus", "von Vorteil", "valued"...) and the offer is NOT blocked.
2026-07-27, the owner's rule: "if it says it's a plus, recommended, or whatever, add
them". This list is what keeps those offers, so it is deliberately WIDE in
the three languages that now block — DE "ein Plus"/"erwünscht", FR "un
plus", NL "strekt tot aanbeveling"/"is meegenomen"/"wenselijk". Being
generous here is the safe direction: it can only let an offer THROUGH.

### titleEncodingBroken · line 1139

NEGATED REQUIREMENT (owner's rule, 2026-07-18: "if it requires it, drop it; if it
doesn't mention it or says it's NOT required, keep it"): phrases like "No German required",
"Kein Deutsch erforderlich", "geen Nederlands vereist", "not compulsory",
"no se requiere alemán"... are GOOD news, not a requirement. If the
phrase contains a negation attached to the requirement word, it's NOT
blocked. (Without this, "No German required" discarded the offer — backwards.)

### bodyLanguageBlock · line 1147

KNOWN LIMIT, left alone on purpose (2026-07-27). Some portals write
their requirements as "* bullet * bullet * bullet" with no full stop, so the
whole block is ONE sentence — 1639 characters in the real case, #699 — and a
"wünschenswert" two bullets away softens a genuine demand. About 5-10% of
bodies come like that. The obvious fix, splitting on the bullet marker, was
already tried for </p> and <br> on 2026-07-18 and REVERTED: it also cuts the
"Nice to have:" HEADING away from the list under it, and that heading has to
keep protecting its own bullets. Any real fix must tell a softener that
INTRODUCES a list from one sitting inside a sibling bullet — and be measured
verdict by verdict first, because the cost of getting it wrong is a good
offer dropped in silence.

### bodyLanguageBlock · line 1163

Audit 2026-07-16: the mitigator ("a plus"/"advantage") only counts if
it's in the SAME sentence as the requirement. Before, it looked ±60 chars
crudely, so "German required. English is a plus" was softened by the
"plus" of the OTHER language → an offer with mandatory German slipped in.

### bodyLanguageBlock · line 1172

Caught 2026-07-18: the negation can come AFTER the sentence break.
Case 1 — question-answer format: "Is Dutch required? No, English
suffices." The answer starting with "No" cancels the requirement.

### langIn · line 1184

Audit 2026-07-18: the comparison of the SAME language in the next
sentence must ignore case ("German required. German is not
necessary here." — with normal capitalization — stayed blocked).

### buildCountryFilter · line 1214

Reads countries.yml (the countries the user turns on or off by editing that
file by hand) and builds the filter: if an offer mentions a country that's
off (or one of its aliases, like "Deutschland" for Germany),
it's discarded.
EXPORTED so a test can reach it (audit 2026-07-31). It was a local, and the
accent bug below — every accented alias silently ignored — lived here for as
long as it did precisely because nothing could call it.

### isOff · line 1234

WHOLE-WORD matching (audit 2026-07-25). This used to be a raw substring
test, so switching Denmark off also killed anything in "Brandenburg" (its
alias "Brande") and Italy off killed "Romainville" ("Roma") — allowed
places, dropped in silence.

### isOff · line 1248

FOLD THE TEXT TOO (audit 2026-07-31). boundaryRegex folds the TERM —
"Zürich" becomes "zurich" — so testing it against the raw location
could never match the accented spelling, and every accented alias in
countries.yml was dead: "Zurich" was correctly dropped while
"Zürich" walked through the gate. Every sibling matcher in this file
folds both sides, and the note above boundaryRegex says so in as
many words. Measured on real scan history with one country switched
off, 110 of its 141 locations leaked through this rule.

### roleKey · line 1290

Second anti-duplicate barrier: the same role can come back with ANOTHER
link (aggregators re-post it). It's compared by the company+title
pair, normalizing odd dashes and extra spaces: GE Vernova posted the same
role twice as "Power Systems - …" and "Power Systems – …" (en dash).
Exported to be tested: this key is what makes your "no" stick when a board
re-posts the same job with a different link. A mutation that stopped it
normalising the en dash — the exact case that made one employer's role
appear twice — passed every test in the project.
Names that are NOT an employer. Adzuna hides the advertiser on plenty of
ads, and the parser used to write its own name into the field — so every
anonymous "Offshore Engineer" in the country shared one key and the second
one was thrown away as a repost of the first. No key means no role barrier;
the link barrier still catches a genuine duplicate.
Exported: housekeep's weekly dedup keys on company+title too, and a rule
written twice is how the two ends drift. LinkedIn is here for the same
reason as Adzuna — parseLinkedInCards writes it when the ad names nobody.

### norm · line 1309

Also (Lonza case #595/#602, 2026-07-18): German portals
re-post the SAME role with gender tags "(m/w/d)"/"(All
Genders)" and schedules "80-100%" that vary between postings. They're removed
before comparing, so the re-post doesn't dodge your decision.
(2026-07-19, Sartorius case "(x w m)") the separator of the gender tag
can also be a simple space, not only / | , .
ENTITIES FIRST, or the key never matches the one rebuilt from disk. This
key is built from the title as the BOARD sent it, while pipeline.md holds
the title after sanitizeField decoded it — so "Automation &amp; Controls
Engineer" produced two different keys and the barrier was dead for it.
Nine of 1,016 real titles carry an entity, all of them his kind of role,
and the effect is that a re-post under a new link comes back and a "no"
on it never sticks.
The normalisation itself lives in text.mjs (titleKey), shared with
housekeep's fuzzyKey so the two ends can never drift apart again.

### pipelineRoleKey · line 1330

Loads the company+title pairs that must BLOCK repeats.
Rule (2026-07-18, Engibex case): only the ones YOU decided block:
  · the ones still VISIBLE in your list (you already have them in front of you),
  · the ones YOU removed (seen/no — they carry the "| visto" marker at the end),
  · the ones in your applications record (applications.md),
  · the ones you rejected with a reason (feedback.jsonl).
The ones THE BOT hid (dead link, old cleanups) no longer block:
if the company re-posts that offer with a new link, it comes back to your list.
(Before, it blocked EVERYTHING hidden, and Engibex's "Junior Project Engineer (Offshore)",
hidden by a cleanup, ate its reappearances.)
Decides, for ONE line of pipeline.md, whether its company+title pair must
block reappearances. Returns the key if it blocks, or "nothing" if not.
  - [ ] ... (visible)            → blocks (you already have it in front of you)
  - [x] ... | visto              → blocks (YOU removed it)
  - [x] ... (no "visto" marker)  → does NOT block (the bot hid it; if they
                                   re-post it, it comes back to your list)
Exported so it can be tested in test-filter.mjs.

### admissionVerdict · line 1415

Judged SEAT BY SEAT (audit 2026-08-08), like the location gate one line
up and the Workday enrichment: fed the joined string, the toggle killed
"Rotterdam, NL; Esbjerg, DK" whole with Denmark off, though the Dutch
seat passed both gates on its own — one seat you can take is enough.

### capJobs · line 1434

A CEILING ON WHAT ONE EMPLOYER CAN ADD IN ONE RUN (audit 2026-07-31).
Workday and Oracle already had one; the other boards took whatever the feed
said. Provoked with a feed answering 20,000 postings: all 20,000 went into
the pending list — a 2.2 MB file and, with Telegram on, about 450 messages
over nine minutes. The cap sits far above any real board, so it only ever
fires on a broken or hostile feed, and it SAYS SO rather than truncating in
silence.
Exported so it can be tested: written inline it was a rule no test could
reach, and it survived a mutation that removed it entirely.

### appendToPipeline · line 1456

Under lock. The scan runs every two hours and takes minutes, but this
part — read the file, add the offers, write it back — must not overlap
with a "seen" from Telegram or with the cleanup. Whoever wrote second
used to erase the other's work: measured, eight overlapping writers kept
200 lines out of 1600. Only these milliseconds are held, not the scan.

### appendToPipelineLocked · line 1470

Finds the highest number already used in the file to keep counting
from it (a number is never repeated). It counts the # at end of line
AND the # right before the "| visto" marker (audit 2026-07-18: the
loose pattern could swallow a "#123" that came inside a title).

### appendToPipelineLocked · line 1475

HIGH-WATER MARK (audit 2026-07-25). The count above is the largest id
still PRESENT in the file, and housekeep DELETES lines — so when the
highest-numbered offer died, the next new offer got that same number
again, and two different offers ended up sharing one "#412". We also
remember the highest id EVER handed out, so numbers only move forward.

### appendToPipelineLocked · line 1487

2026-07-18 (approved improvement): if the years asked (y:) or the
salary (s:) are known, they're saved in the line — the "list" command shows them.
The #number is still the last field (the "seen" command requires it).
y: only ever carries a NUMBER (audit 2026-07-25). multiYearScreen returns
the string '3+', and "y:3+" is not a shape the list parser recognises, so
that offer was displayed as if "3+" were its LOCATION.

### appendToPipelineLocked · line 1509

TIDY (audit 2026-07-25): every scan used to leave one orphan blank line
behind, and housekeep's deletions leave more — a live file had grown to
376 blank lines out of 486. Runs of blank lines collapse to one.

### loadIdHighWater · line 1523

The highest offer number ever handed out. Reading it is deliberately
paranoid, because getting it wrong gives two different jobs the same number:
answering "no 412" from an older message would then hit the wrong one, and
the rejection history would mix them up.
IT NO LONGER TRUSTS ONE FILE (audit 2026-07-31). If data/last-id.json is
lost or corrupt it used to fall back to zero, leaving the pipeline — a file
housekeep DELETES from — as the only source, so the counter walked backwards
over every number whose line had been removed. Provoked: deleting the
counter and the top lines handed #4 to a second, different job.
So it also reads every other place a number was ever written down. Those
files are append-only records, which makes them a floor the counter can
never fall below.
The paths are arguments so a test can prove this on files of its own, never
on yours.

### next · line 1587

ERROR ISOLATION 2026-07-25 (audit): a single throwing task used to abort
its whole worker, so one bad link could cut a sweep short and make the
remaining offers look like they simply were not there.

### rank · line 1604

Order in which the reasons are shown (first the ones that reach you).
COMPANY and DEFERRED were missing (audit 2026-07-25): their offers were
written to the report but never counted in the summary at the top.

### runVerdict · line 1707

(audit 2026-07-31) Argus's normal failure is to find nothing, which looks
exactly like a quiet week. Three different breakages produced a clean exit
and total silence: no network (every source failed), a config that parses
but selects no sources, and a config that lists sources none of which
answered. The scan wrote down the error count and NOTHING read it.
NOT "everything errored" — "nothing answered". A source that is switched
on but never reached raises no error at all: a missing Adzuna key is
reported as skipped, and LinkedIn's cadence and cooldown paths return in
silence. Requiring an error meant the quietest failure of all — the one
this alarm exists for — could not set it off.
A --company run is exempt: it deliberately scans one board with the
aggregators switched off, so "no aggregator answered" is the point of the
command, not a fault worth waking you for.
Pure and exported so the decision can be tested without a scan.

### main · line 1787

Until the 2026-07-25 audit these SOURCES were fixed in portals.yml, which
made the engine filter correctly for anybody but always over a marine
stream: a non-marine user got a perfect filter applied to offers that were
never theirs, i.e. an empty list for ever. Now the search itself can come
from config/profile.yml too. Everything below falls back to portals.yml,
so a profile that does not define these keys behaves exactly as before.
search.queries: the phrases to ASK the job boards for (plain words, e.g.
  ["financial accountant", "bookkeeping"]). They feed Adzuna, LinkedIn and
  the Workday search boxes at once.

### main · line 1811

The COUNTRIES must follow the profile too (audit 2026-08-08). Only the
queries did: an onboarded user's whole Adzuna budget went to the marine
example's seven countries — whose results their own location filter then
killed — while the countries they chose, whose adzuna codes the
onboarding records for exactly this, were never queried. LinkedIn
already followed the profile; Adzuna, the biggest source, did not.

### targets · line 1836

Counted against the SAME set targets was built from (audit 2026-07-25):
with --company it compared against every enabled company, so it reported
"28 skipped — no direct API" when the other 28 were simply not asked for.

### logDrop · line 1860

--explain mode (2026-07-18): it records, offer by offer, WHY each
one was discarded, so it can give you the complete "one line per
offer" list (dumped to data/scan-explain.txt). It does NOT change the normal scan:
without --explain, logDrop does nothing.

### partial · line 1990

A CEILING ON WHAT ONE EMPLOYER CAN ADD IN ONE RUN (audit 2026-07-31).
Workday and Oracle already had one; Greenhouse, Lever and Ashby took
whatever the feed said. Provoked with a feed answering 20,000
postings: all 20,000 went into the pending list — a 2.2 MB file and,
with Telegram on, about 450 messages over nine minutes. The cap sits
far above any real board, so it only ever fires on a broken or hostile
feed, and it SAYS SO rather than truncating in silence.

### collectFromAdzuna · line 2018

NOT an error: the Adzuna key is optional and the README says so, but
this used to be listed under "Errors" on every scan of a fresh
install — which reads as "your setup is broken" when nothing is.

### enrichWorkdayLocations · line 2069

The description travels in this same response; stashing it saves
fetchOfferDescription re-downloading the identical URL minutes
later (audit 2026-08-08 — every enriched offer paid it twice).

### screenRequirements · line 2124

The threshold comes from the profile ("5+ years → skip", "3-5
borderline"), so anything above max_years is dropped and anything
unknown is kept.
Years-of-experience and degree step: the text of each accepted
offer is downloaded and, if it clearly asks for more years than the user can
offer, or requires a degree the user does not have, it's discarded. If it's unknown,
the offer stays. With that same text the refined language rule
is applied (2026-07-18): it doesn't matter which language the
offer is WRITTEN in; it's only discarded if the body REQUIRES a language the user does not speak.

### screenRequirements · line 2151

OrcaFlex rule (2026-07-11): if the offer mentions OrcaFlex —
HIS star tool, which barely anyone knows — it stays in the list
even if it asks for more years than the cap. The language is still
checked. The term list lives in the profile (search.priority_terms).

### screenRequirements · line 2163

DEGREE requirement in the body (2026-07-16): if the text requires
a master's/degree in a field the user doesn't have (mechanical/electrical/
electronics...) and mentions none of the user's fields, out. OrcaFlex
exempts just like with the years.

### screenRequirements · line 2168

Refined language rule (2026-07-18): it does NOT matter which language
the offer is written in — it's only discarded if the body REQUIRES a
language you don't speak (and not as "valued/a plus"). For Adzuna the
clean description region is used (or the API snippet);
never the whole page, which carries menus in the country's language.

### screenRequirements · line 2177

DEFERRAL (the user gave the OK 2026-07-18, case #626/#627): if the
detail page could NOT be read (429 exhausted), the offer isn't shown to you
half-examined. It's left out WITHOUT recording it anywhere, and
the next scan (2 h, fresh quota) re-finds it and examines it
fully. OrcaFlex exception: if the snippet already names your star
tool, it comes in anyway — it's not risked being lost.

### dropDeadLinks · line 2215

The experience screen already downloaded this very page and left the
verdict's evidence on the offer — judging from it avoids a second
download of the whole batch (audit 2026-08-08). Only offers that
arrived without evidence (screen skipped or errored) still fetch.

### persistAndNotify · line 2263

THE LIST WAITS FOR THE COUNCIL (the user, 2026-08-03). The alert used
to go out the moment the offers landed, and the verdicts arrived by a
silent replacement ~3 minutes later — so the ping always showed the
newest offer with no [YES]/[NO] on it. With the Council on, the new
offers are judged FIRST and the one alerted list already carries
every verdict. Capped and best-effort: judges failing or timing out
mean an untagged list, never a missing or a late one.
(The interactive "search" path skips this block with the refresh.)

### persistAndNotify · line 2287

THREE DIFFERENT ANSWERS, not two (audit 2026-07-31). refreshList
returns null when Telegram is not set up and false when the send
FAILED, and both used to be written down as "not-configured": the
summary a human reads said the bot was not set up when it was, while
the new offers had already been written to the pending list and to
the anti-repeat history — so they could never be offered again, and
you were never told about them once.

## seen.mjs

### parseIds · line 23

These are the FIXED offer numbers (#412 as shown on Telegram), never a
position in the list, so the wrong one can't be marked. De-duplicated
(audit 2026-07-25): "seen 701 701" appended "| visto" twice and broke the
"#id at end of line" shape the id counter and the parsers rely on.

### restorePendingInLines · line 68

The exact inverse of the marking above, for the "undo" command and the
review card's Undo button (2026-08-22): "- [x] ... | visto" back to
"- [ ] ...". ONLY lines carrying the "| visto" tag — that tag means the
hiding was YOUR decision; a line the cleanup hid on its own (dead link)
has no tag and is not brought back by an undo.

### restorePendingInLines · line 97

Read, mark and write INSIDE the lock. This runs from Telegram, so it can
fire at any second — including while the scanner is appending or
housekeep is deleting. Without the lock, whichever wrote last wiped the
other's work; with it, a "seen" can no longer be swallowed by a scan that
started a moment earlier.

## telegram-listener.mjs

### (module level) · line 3

WHAT IT IS: the Telegram "remote control" for your job search.
It reads the messages YOU send to the bot's chat and turns them into actions:
launch a search now (search), view the pending offers (list),
generate an offer's cover-letter PDF (cover N), or
remove offers from the list (seen, or "no" with a reason to improve the filter).
WHEN IT RUNS: always. It keeps one quiet connection open to Telegram
(long polling) and reacts the moment you send something — about a second.
The schedule that used to run it every minute now only revives it if it dies.
WHAT IT USES: telegram.json (bot keys), telegram-offset.json (remembers where
it was reading), notify.mjs (send messages/PDFs), list-offers.mjs
(pending offers), seen.mjs (mark as seen), scan.mjs (search),
cover-letter.mjs (cover letters), and writes to feedback.jsonl (your rejections).

### (module level) · line 65

The review mode (2026-08-22): the pending offers one card at a time, with
buttons. Decisions run THIS file's command handlers in quiet mode, so a
button and a typed command are one code path.

### (module level) · line 69

EXPERIMENTAL (2026-08-24): the "no" that teaches — a one-tap veto panel
after each typed rejection, and the "vetoes" command to manage them.

### runNode · line 166

Runs another of the bot's scripts (for example seen.mjs, the one that marks
offers as seen) and collects everything it prints, to forward to you via Telegram.
process.execPath, not 'node' (2026-08-12): children run on the EXACT same
runtime as this process — immune to PATH surprises, and on Windows, where
the schedule runs the bot as argus.exe, every child shows up in Task
Manager under the product's name instead of as an anonymous node.exe.
scan.mjs already did it this way.

### flipListPage · line 207

What to tell you after a "seen" command, given the ids you asked for and
everything seen.mjs printed.
HONEST reply (2026-07-25): it used to say "Marked as seen" even when the
number did not exist (already handled, or removed by the 07:30 clean-up),
so you believed you had filed an offer that was never touched.
IT NOW READS WHAT WAS MARKED, not what failed (audit 2026-07-31). The
reply was built by looking for "#N is not in pending" and calling
everything else a success — so any OTHER outcome (an empty pending
section, a failed write, the program dying) still answered "Marked as
seen", which is exactly the dishonesty the earlier fix set out to remove.
seen.mjs prints a "  ✓ #N ..." line for each id it really marked, and that
list is the only thing worth believing.
Exported and pure so it can be tested: the command surface of this file had
no test at all, which is why a reply could go on lying for a week.
Turns a page of the live list when its Prev/Next button is tapped
(owner-requested, 2026-08-19). The pages were written to disk by the
process that sent the list; this runs in a LATER listener process, so the
file is the only bridge. The stored message_id must match the tapped
message: a tap on an older list answers with a toast instead of quietly
redrawing the wrong thing. Returns false only when the tap is not a page
button at all, so the caller can route it to the onboarding instead.
Exported and dependency-injected so the honesty rules are testable.

### recordApplicationState · line 308

ESCAPED (audit 2026-07-31). The title and the company come from a job
portal and the reason is what you typed — none of it is ours. Sent as
HTML without escaping, a title carrying "<" or "&" makes Telegram refuse
the whole message, so the confirmation that the application was closed
never arrives while the file has already changed.

### rejectWithReason · line 320

The "no N reason" command ("no 3 needs 5 years of experience"): removes
offer 3 from pending AND records why it didn't fit in feedback.jsonl.
That file is your rejection history — read it before touching the filters,
so any change to them comes from your real criteria (and with tests).
quiet (2026-08-22): the review card runs this same function for its "No"
button — records and honesty checks identical, but the card is the
confirmation, so the chat message is skipped. The return value carries
what the card and a later undo need: found, gone, and the record's ts.

### rejectWithReason · line 354

Read what seen.mjs SAYS it removed before confirming (audit 2026-08-08):
the plain `seen` command was hardened exactly this way, but this reuse
kept confirming success over a failed write — the confirmed-but-not-done
reply the 2026-07-31 audit removed, reintroduced by the side door.

### markApplied · line 455

Same honesty as `seen` and `no` (audit 2026-08-08): confirm only what
seen.mjs reports actually removed, and say so when the write failed.

### mailCommand · line 542

Is it "applied N"? → record that you SENT the application:
it's logged in data/applications.jsonl (your history of sent applications) and
the offer drops off pending (and won't come back even if reposted).
(optional separator — "applied5" without a space is also valid, audit)
"longshot 729 I don't have the 3 years" — checked BEFORE "applied" so the
two never race, and the trailing text is kept as the requirement you fall
short of (same shape as "no N reason").
➜ "mail": where every application you have sent stands. The twin of
➜ "list" — one shows the offers waiting for you, the other what came back
➜ from the ones you sent. It RE-READS THE INBOX FIRST (2026-08-05): the
➜ report used to be whatever the nightly run left, so "mail" could answer
➜ with yesterday. If Gmail cannot be read right now (down, token expired),
➜ the last report is shown with its date rather than nothing. The nightly
➜ run stays — it keeps the report fresh without being asked.
➜ "status" still answers too: it was the first name this had.

### mailCommand · line 572

ONE mail report in the chat, not a pile: each "mail" replaces the
previous report, the same discipline as the live list. Send FIRST,
delete after — a failed send must never leave the chat with no report
at all. The previous ids ride in data/mail-message.json.
CHUNKED like the offers list (audit 2026-08-08): the report grows one
line per application and Telegram refuses anything over 4096 chars —
around 60-odd listed applications the single send started failing
EVERY time, exactly when there was most to report.

### mailCommand · line 609

"/start" → the one-time setup (CV + profile questions).
"/start yes" confirms replacing a profile you already have: the first
question is "paste your CV", and from then on ANY text you type is stored
as an answer — so starting again by accident used to cost you the CV.
"/start abc12345" is the installer's deep link (t.me/bot?start=CODE):
Telegram delivers the code as a payload, and it reads as a plain /start.

### mailCommand · line 641

Is it "list"? → send the pending offers grouped by country.
(Button history: per-offer buttons ON THE LIST were tried 2026-07-18 and
removed the same day — under a 25-offer message no button can say which
offer it belongs to. On 2026-08-22 the owner approved buttons on the
review CARD instead, one offer per message, where they are unambiguous.
The list itself keeps only navigation and the review entry.)

### mailCommand · line 648

"list" now refreshes the live list: deletes the previous one and re-sends the
pending offers to the bottom of the chat (if there are none, it says "No pending offers").
AND IT ANSWERS WHEN IT CANNOT (audit 2026-07-31). If the send failed or
Telegram was not configured, this command produced no list, no error and
no reply of any kind — you were left staring at a chat that had simply
ignored you, with no way to tell that from "there is nothing new".

### mailCommand · line 677

WITH html:true, and the typed note escaped (audit 2026-07-31): this
message is built out of <code> tags and was sent with no parse mode,
so the tags arrived as literal text in the middle of the sentence.

### mailCommand · line 694

Is it "no 3 reason..." (or stuck together "no3")? → reject the offer
recording why. (Optional separator — audit 2026-07-18: "no5"
typed quickly fell through to the help text.)

### mailCommand · line 705

EXPERIMENTAL (2026-08-24): a typed "no" earns a one-tap veto panel
built from what was just rejected. Typed path only for now — the
review cards keep their own rhythm.

### main · line 733

Main routine: asks Telegram whether there are new messages since the
last time, processes them one by one ONLY those coming from your chat, and records
where the reading is up to so it doesn't repeat commands if something is cut off.
pollSeconds > 0 turns the ask into a LONG POLL: Telegram holds the request
open that many seconds and answers the instant something arrives. 0 keeps
the old ask-and-hang-up pass for --once, tests and the diagnose scripts.
Returns how many updates the pass saw, so the loop can tell idle from busy.
These two setup nags repeat on every pass; a person at a terminal needs
them once, not every seven seconds.

### main · line 749

A token but no chat yet: FINISH THE LINK OURSELVES (field test
2026-08-05). The moment any listener polls this bot — this one, or a
survivor of an earlier install — it CONSUMES the "hi" the setup console
is waiting for, and the console then waits two minutes for a message
that no longer exists, for ever. The listener is the rightful owner of
getUpdates, so it completes the link itself; the console notices the
chat_id appearing in telegram.json and moves on.

### main · line 758

The WHOLE backlog, not offset=-1 (audit 2026-08-08). A negative
offset returns only the newest update and — per Telegram's own API
doc — forgets every earlier one. So an owner who tapped START and
then typed anything before this tick had the /start permanently
confirmed away: the tick saw only the second message, refused to
bind, and the bot stayed mute with nothing to show why. A plain
getUpdates confirms nothing and hands back everything pending.

### backlog · line 788

Atomic like every other state file (audit 2026-08-08): a crash mid-
write here leaves invalid JSON in the ONE file holding the token,
and the bot goes mute until the setup is run again.

### backlog · line 792

Position BEFORE the linking message, not after it: this same tick
then PROCESSES that message. Pressing START on the t.me link is one
tap that links the chat AND begins the profile questions — the old
flow linked, greeted, and swallowed the /start it was greeting.

### backlog · line 814

Asks Telegram for the pending messages starting from the last one already read,
with a maximum wait of 15 seconds so it doesn't hang.
WHERE WE GOT TO LAST TIME — the one thing stopping a command being run
twice. Telegram keeps 24 hours of messages and hands back everything from
the offset onwards, so "start from 0" does not mean "start fresh", it
means REPLAY A WHOLE DAY: every `applied N`, every `no N`, every `cover N`
you typed since yesterday, executed again.
So a missing or unreadable file is NOT treated as zero (audit 2026-07-31).
It resynchronises instead: ask Telegram for the latest update only, write
that position down, and run nothing this tick. One tick's messages can be
missed that way, which you would notice and could retype; a day of
commands running themselves again is not something you could undo.

### backlog · line 832

THE FIRST /start FELL IN A HOLE (field test 2026-08-03): a brand-new
user types /start during the setup, this first tick then synchronises
PAST it — deliberately, replaying history is worse — and the user is
left in front of a silent bot. Say the bot is alive and what to type.
Only on a virgin install (setup never completed), so an established
bot that loses its offset file does not greet its owner like a stranger.

### backlog · line 862

ANOTHER RUN MAY HAVE TAKEN OVER (audit 2026-08-08). "search" and
"mail" hold this loop for minutes; on installs without a lock (macOS
ships no flock) the next minute's run reads the advanced offset and
handles the rest of the batch — and this run, resuming its stale
in-memory array, used to execute those same commands a second time.
The offset file on disk is the single truth of what is already done.

### backlog · line 873

Persisted BEFORE handling, so a crash cannot replay the command — and
written aside-then-renamed, so a crash cannot leave this file half
written either. It was the only plain writeFileSync left in the project,
on the one file whose corruption replays a day of commands rather than
losing one (audit 2026-07-31).

### backlog · line 902

A FILE while the setup waits for the CV: people send the PDF they
already have, not pasted text (field test 2026-08-06). Only the CV
question eats documents; everything else needs text.

### bornMtime · line 980

Startup: `--once` keeps the old single pass (tests, diagnose scripts, and
anything that must not stay resident); otherwise the always-on loop runs.
If something blows up, the program exits quietly (the watchdog schedule
launches a fresh one within a minute).
ONLY WHEN THIS FILE IS THE PROGRAM BEING RUN. It used to start on import,
so anything that so much as read a function out of this file started the
bot: a test importing it would have polled Telegram with the real token and
executed whatever commands were waiting. Every other module in the project
already guards its entry point this way (audit 2026-07-31).

## text.mjs

### (module level) · line 1

The three text helpers every module used to carry its own copy of.
Seven accent-folders had grown across the engine, five identical and two
near misses; the title-key normalisation was pasted into scan and
housekeep separately and had already drifted once. One home, one meaning.

### titleKey · line 17

A title reduced to what identifies the ROLE, for telling a re-post from a
new vacancy: gender tags "(m/w/d)" / "(x w m)" / "(all genders)" and
schedules "80-100%" vary between postings of the same job and go, dashes
are unified, whitespace collapsed, trailing punctuation dropped. Case is
lowered but accents are KEPT on purpose — a key is only ever compared with
a key built the same way from the same source.
The gender-tag pattern is written WITHOUT ambiguous repetition (CodeQL
round, 2026-08-24): an optional-separator form backtracked exponentially
on a title like "(m m m m …" with no closing paren, and titles come from
the boards. Separators are one mandatory run; a fused "(mwd)" has its own
branch.

## vetoes.mjs

### (module level) · line 1

EXPERIMENTAL (2026-08-24, in no release yet): the "no" that teaches.

WHAT IT IS: until now "no N reason" only wrote a record a human reads
when hand-tuning the filters. This makes the rejection ACT: right after
one, the bot reads the rejected offer and offers one-tap standing vetoes
— the distinctive words of its title, its company, its city. One tap and
offers matching it never reach the list again.
WHY BUTTONS AND NOT A COMMAND: a "veto <word>" command makes the user do
the analysis. The offer is right there; the bot can propose and the user
only has to recognise. Free text stays what it was — the reason record.
WHY A FILE OF ITS OWN (data/vetoes.json): the profile is REGENERATED from
the onboarding answers on every settings edit, so anything written into
profile.yml by another door gets silently wiped. This store survives, and
scan + housekeep merge it into the filters they build.
EVERY VETO IS REVERSIBLE: Undo on the panel just after the tap, and the
"vetoes" command lists every standing one with a remove button.

### (module level) · line 36

Two panels, each bound to its own message id so a tap on yesterday's
buttons cannot act on today's state (same binding review and the
onboarding use — the stale-tap lesson of the 2026-08-23 field test).
