# CS2103/T team progress tracker

The official CS2103/T dashboards cover the whole cohort and are anonymous. This
Cloudflare Worker filters them down to one single team and posts two Telegram digests a week.

- **A live dashboard.** iP increments, Git/GitHub items, participation and forum
  posts for your team, side by side, auto-refreshing.
- **Thursday 6pm SGT: status.** Who still has something outstanding, how many
  commits each person pushed this week, participation so far, forum post counts.
- **Friday 4pm SGT: the week ahead.** The Admin / iP / tP task lists for the week
  that starts at that moment, with every deadline.

Everything team-specific is configuration. Point it at your own roster and it
works for any team in the course.

## Demo

![The dashboard, showing a sample team](docs/dashboard.png)

Everyone's increments, Git items, participation and forum posts sit side by side, 
and the summary shows what is outstanding: Chris is behind, Bo has this week's work still to do, 
and Dana has finished everything but pushed nothing inside this week's window, which is what the red
`3` under weekly commit activity means.

And the two digests as they arrive in the group chat, Thursday's status report
above and Friday's week ahead below:

<img src="docs/telegram.png" alt="The two Telegram digests" width="420">

## Setup

You need a Cloudflare account (the free plan is enough) and a Telegram bot.

```sh
git clone https://github.com/dillionlim/cs2103-team-tracker.git
cd cs2103-team-tracker
npm install
```

`npm install` pins Wrangler for this project. Every command below is an npm
script, so it uses that pinned copy rather than prompting to download one.

**1. Get the ids.** Open the [iP progress dashboard][ip] and find your teammates'
rows. Each is labelled `A---1234A`; the part after the dashes is the id to use.
The GitHub handle is whatever the [forum dashboard][forum] lists after the `@`,
and it is matched case-insensitively.

**2. Fill in `wrangler.toml`.** It is gitignored, so start from the sample:

```sh
cp wrangler.example.toml wrangler.toml
```

Change `name` to your own Worker name, then set the `[vars]`:

```toml
[vars]
TEAM = """
1234A:Alex:alex-gh
5678B:Bo:bo-gh
"""
TEAM_NAME = "CS2103T W00-0"
COURSE_SITE = "https://nus-cs2103-ay2627-s1.github.io"
PUBLIC_URL = "https://<your-worker>.<your-subdomain>.workers.dev"
```

One member per line, `id:name:handle`. The handle may be omitted (`1234A:Alex`);
that person's forum count then reads as not set. `TEAM` also accepts a JSON
array of `{"id","name","handle"}` if you prefer.

**3. Make the bot.** Message [@BotFather](https://t.me/BotFather), `/newbot`, and
keep the token. Add the bot to your group, then send
`/start@your_bot_name` there, since group privacy mode means it only sees
messages addressed to it. Read the chat id back:

```sh
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

It's the `message.chat.id`, negative for groups.

**4. Set the secrets.**

```sh
npm run secret TELEGRAM_BOT_TOKEN
npm run secret TELEGRAM_CHAT_ID
npm run secret DIGEST_KEY      # any random string; guards /api/digest
```

**5. Deploy.**

```sh
npm run deploy
```

The URL it prints is the dashboard. Put that same URL in `PUBLIC_URL` and deploy
once more if you hadn't already.

**6. Check the schedule reads back the way you meant it.** In the Cloudflare
dashboard, under the Worker's Settings $\to$ Cron triggers, each trigger is spelled
out in words with its next run date. **Cloudflare counts day-of-week as
1=Sunday…7=Saturday**, one ahead of standard cron. That is, Thursday is `5`, not `4`.
Which digest a firing sends is read off the day it lands on, so there is nothing else to keep in step: Friday sends the week ahead, any other day sends the status digest.

## Checking it without waiting for a cron

`DIGEST_KEY` guards a route that builds either digest on demand:

```sh
BASE=https://<your-worker>.workers.dev/api/digest?key=<DIGEST_KEY>

curl "$BASE"                              # the Thursday status digest
curl "$BASE&type=week"                    # the Friday week-ahead preview
curl "$BASE&type=week&at=2026-09-18T08:00:00Z"   # ...as it would read on that day
curl "$BASE&send=1"                       # actually post it to the group
```

The route is key-guarded because the dashboard itself is public and anyone could
otherwise spam your group chat.

## How it reads the sources

The three dashboards are MarkBind pages whose tables are server-rendered, so the
Worker fetches and parses them at the edge and hands the browser ~9 KB of JSON
instead of ~2.5 MB of HTML. 

## Development

```sh
npm run dev                 # http://127.0.0.1:8787
```

Local runs read secrets from `.dev.vars` (gitignored):

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
DIGEST_KEY=...
```

Note: `&send=1` against a local dev server still posts to the real group.

`[observability]` is on, so every invocation, cron firings included, keeps its
logs. Read them under Workers $\to$ your Worker $\to$ Logs, or live with
`npm run tail`, which shows each firing's `outcome`, `logs` and
`exceptions`.

## Layout

```
package.json           pins Wrangler and wraps the commands below
src/index.js           the Worker: parsing, both digests, cron dispatch
public/index.html      the dashboard page, served as a static asset
wrangler.example.toml  copy to wrangler.toml: roster, course URL, cron schedule
```

[ip]: https://nus-cs2103-ay2627-s1.github.io/dashboards/contents/ip-progress.html
[forum]: https://nus-cs2103-ay2627-s1.github.io/dashboards/contents/forum-activities.html
