# Tinybird: dog diary, PetAnalytics and telemetry

Tinybird keeps five DogMaAI tables, each defined in [tinybird/datasources](./tinybird/datasources):

| Table | What it holds |
|---|---|
| `dog_diary` | Liquid AI's description of the dog, one row each time its activity or place changes. The manager reads it back for the **Dog diary** panel |
| `dog_readings` | Each camera reading of the dog: whether it is visible, what it is doing, where, and whether a person is in view, about one every 12 seconds while a manager page analyzes a live camera. **PetAnalytics** reads the last seven days |
| `dog_sounds` | One row per minute the home camera's microphone was heard: how many seconds the dog was crying (a whimper or a howl) or barking, as recognised by the YAMNet sound model on the owner's computer. No audio is stored. **PetAnalytics** reads the last seven days |
| `dog_events` | Comfort sounds as they start, with where they came from. **PetAnalytics** uses them to see whether the music helped. Older rows may also hold meals from the removed **Fed** button |
| `nightwatch_state_changes` | An analytics mirror of every processed observation and accepted state mutation in the sample journal. SQLite stays the source for canonical state and restart recovery |

No table holds images, camera frames or sound. Readings carry only the four labels above, sound rows only counts of seconds, and events only their kind, the sound's name and their source. Telemetry rows carry event IDs, times, session and situation IDs, state versions, latency, working-state size and the mutation JSON; diary rows carry the description and the dog's visibility, activity and place.

## Set up a workspace for DogMaAI

Use a Tinybird workspace that holds nothing else. Newer (Forward) workspaces accept new tables only through a deployment, and a deployment defines everything in the workspace, so sharing one with another project could affect that project.

1. In [Tinybird](https://cloud.tinybird.co), create a workspace for DogMaAI.
2. On its Tokens page, copy the workspace admin token.
3. Run `npm run tinybird:setup` and paste the token at the prompt, where typing is hidden. The API host comes from the token's region (for example `https://api.us-west-2.aws.tinybird.co`). The token is kept in `.env` as `TINYBIRD_ADMIN_TOKEN`, so later runs ask for nothing; if it is refreshed in Tinybird, the script asks for the new one. If a token is ever pasted where it shows on screen, refresh it in Tinybird before using it.

The script checks the token, refuses a workspace that already holds tables other than DogMaAI's, runs `tb deploy --check` and then `tb deploy` with the Tinybird CLI (`TINYBIRD_CLI` in `.env`, or `tb` on PATH), and passes the token to the CLI only through its environment. The deployment creates a token called `dogmaai_app` that can only add to the five tables and read `dog_diary`, `dog_readings`, `dog_sounds` and `dog_events`. The script saves that token as `TINYBIRD_TOKEN`, with `TINYBIRD_API_URL`, to `.env`, which DogMaAI uses. The admin token is saved too, at the owner's request, as `TINYBIRD_ADMIN_TOKEN`: only the setup script reads it, the DogMaAI API removes it from its environment at start, and child processes such as go2rtc and ffmpeg never receive `.env` values. It can change anything in the workspace, so keep `.env` private (it is ignored by Git and written readable only by you). Restart DogMaAI afterwards. Run the script again after changing a table definition, and once more if Tinybird was set up before PetAnalytics added `dog_readings` and `dog_events`.

## How DogMaAI uses the tables

- **Diary writes** go to the Events API with `wait=true`, so a row counts as saved only after Tinybird confirms it; rows Tinybird sets aside in quarantine stay marked **Not saved yet** and are sent again. Reads use the SQL API (`SELECT … FROM dog_diary … FORMAT JSON`).
- **PetAnalytics readings** go to the Events API in batches every 30 seconds (or every 20 readings). A batch counts as delivered once Tinybird accepts it, and rows it quarantines are not sent again, since they would fail again and resending would repeat the rows it kept. A passing failure keeps up to 500 unsent readings for the next batch; a missing table or a token without permission stops the writes, and the PetAnalytics page says to run `npm run tinybird:setup`. Tinybird's own error text is never shown.
- **Sound minutes** go in the same 30-second batches as readings.
- **Comfort sounds** are written with `wait=true`, like the diary, so a sound counts as logged only after Tinybird confirms it.
- **PetAnalytics reads** use the SQL API over the last seven days, at most once a minute. If a read fails, the page keeps showing the last data it read and says so, and logging stays on.
- **Telemetry** sends each two-second sample as one NDJSON batch, well below the Events API rate limits. Permanent 4xx errors pause telemetry until the API restarts; transient failures retry after a short cooldown. Telemetry failures never block monitoring.
- Without a Tinybird token, the diary keeps entries for the current session only, and PetAnalytics shows its sample week. Tinybird was first connected live on 28 September 2026.

Optional settings:

```dotenv
TINYBIRD_API_URL=https://api.us-west-2.aws.tinybird.co
TINYBIRD_DATASOURCE=nightwatch_state_changes
TINYBIRD_CLI=/path/to/tb
```

The older variable name `TINY_BIRD_API` is still accepted for the token. A 403 usually means the token lacks the permission or the host belongs to another region.
