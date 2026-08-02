# argus-mail

Reads your inbox once a night, matches the replies to the applications you
logged with `applied N`, and writes one state per application to
`data/application-status.json`. The `mail` command in Telegram prints it.

It is read-only, it never writes a word of your mail to disk, and Argus works
without it — if you do not set it up, `mail` says so and nothing else changes.

## What it does

```
Gmail  ──►  classify  ──►  match  ──►  status  ──►  report
            what kind    which of      one state    the message
            of message   YOUR jobs     per job      you read
```

| File | Job |
|---|---|
| `classify.mjs` | Is this a receipt, a rejection, an invitation, a bounce, or a mailshot? |
| `match.mjs` | Which of your applications is it about — or is it ambiguous? |
| `status.mjs` | One state per application, and your own verdicts on top |
| `report.mjs` | The text of the `mail` command |
| `listen.mjs` | The nightly run that ties them together |

The states, in the order the message shows them:

| | State | Means |
|---|---|---|
| ⚪ | `bounced` | the mail never arrived — worth applying again elsewhere |
| ⚪ | `noreply` | nothing came back at all |
| 🟡 | `acknowledged` | they acknowledged it, and that is all so far |
| 🔴 | `rejected` / `ghosted` | they said no, or two months passed in silence |
| 🟢 | `interview` | somebody proposed talking to you |

Four colours, not six. Every state does not need one of its own: past four the
reader is decoding a legend instead of reading a list. Ghosted shares the red
with a rejection because after two months the answer is the same one — the
difference survives in the record, which is where it is useful. A state nobody
is in gets no line at all, with one exception: the interview count is always
shown, because that is what all of this is for and "0" says something.

**Closing one by hand.** Some employers never write: the verdict is on their own
portal, or their address bounces and nobody fixes it. `no N` in Telegram records
that the application is finished, into `data/application-verdicts.jsonl`, and it
is applied *on top* of whatever the mail says — the nightly run rebuilds
everything from scratch, so without that it would be wiped every midnight. It is
deliberately not written to `feedback.jsonl`: that file trains the offer filter,
and "they never answered" is no reason to stop looking for jobs like that one.

Run it by hand with `--dry-run` to see what it would write:

```bash
node server-bot/argus-mail/listen.mjs --dry-run
```

## Setting up Gmail access

You need a Google Cloud OAuth client of your own. It is free, it takes about ten
minutes, and nothing leaves your machine.

**1. Create the project and enable the API.** At
[console.cloud.google.com](https://console.cloud.google.com), create a project,
then enable the **Gmail API** for it.

**2. Configure the consent screen.** External user type; add yourself as the
only user. **Set the publishing status to "In production".** While it is in
"Testing", Google expires the refresh token after **7 days** and the nightly job
starts failing a week later for no visible reason. Verification is not needed:
Google exempts apps used by their own author. You will see an "app not verified"
warning when you authorise — that is expected, continue past it.

**3. Create the credentials.** Credentials → Create → **OAuth client ID** →
application type **Desktop app**. Download the JSON and save the two values into
`server-bot/gmail-oauth.json`:

```json
{ "client_id": "....apps.googleusercontent.com", "client_secret": "GOCSPX-..." }
```

> Google's own documentation marks `client_secret` as *optional* for installed
> apps, on the grounds that a desktop app "cannot keep secrets". Their token
> endpoint rejects the exchange without it. Include it.

**4. Authorise once.**

```bash
node server-bot/gmail-auth.mjs
```

It prints a URL and waits. Open the URL yourself, approve, and the script saves
the refresh token to `server-bot/gmail-token.json`. Both files are `chmod 600`
and both are covered by `.gitignore`.

> The script deliberately does **not** open your browser. Every reliable way of
> doing that from Node on Windows mangles the URL: `cmd /c start` cuts it at the
> first `&`, which makes Google answer "Required parameter is missing:
> response_type" and sends you hunting for a bug that is not there. Copying the
> URL yourself always works. A test keeps it that way.

**5. Schedule it.** Once a night is plenty — replies are not urgent, and the
window it reads starts at your oldest logged application.

```
0 0 * * * cd ~/argus && /usr/bin/flock -n /tmp/argus-mail.lock /usr/bin/node server-bot/argus-mail/listen.mjs >> server-bot/mail.log 2>&1
```

On Windows, the same thing as a scheduled task:

```
schtasks /create /tn "argus-mail" /tr "node C:\path\to\argus\server-bot\argus-mail\listen.mjs" /sc daily /st 00:00
```

## The scope, and why it is the only guarantee that matters

The token is issued for `https://www.googleapis.com/auth/gmail.readonly` and
Google enforces that on their side. A request to delete a message comes back
`403 insufficient authentication scopes` no matter what this code asks for, so
the guarantee does not rest on the code being correct.

Two smaller locks sit on top: every read goes through one function with `GET`
written into it rather than passed in, and a test reads `gmail.mjs` as text and
fails if a second verb ever appears in the file.

## Teaching it new wording

`classify.mjs` is word lists, on purpose — no model, no API key, nothing to pay
for per message. When a company phrases something in a way it does not know, the
message is filed as unknown rather than guessed at, and adding the phrase fixes
it for good. Add it to the right list and add a test alongside the others.

One rule for those tests, learned the hard way: **a test string must trigger
exactly one pattern.** Several fixtures used to match two or three at once, so
deleting any single pattern left the suite green and the hole invisible.
