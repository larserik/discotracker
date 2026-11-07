# DiscoTracker

An online music tracker in the spirit of FastTracker 2, ProTracker, NoiseTracker and StreamTracker.
Load, play, edit and save **.MOD** and **.XM** modules right in the browser – no account needed.
Signing in (email + one-time code) lets you keep your songs on the server.

## Features

- Loads and saves **MOD** (ProTracker/NoiseTracker/SoundTracker 15-sample, 4–32 channels) and **XM**
- Tick-accurate replayer with FT2/ProTracker effects, XM volume column, envelopes, fadeout,
  auto-vibrato, linear & Amiga frequency modes – mixed in an `AudioWorklet`
- Pattern editor with FT2 keyboard layout, edit/record mode, chords while jamming,
  block select/copy/paste, transpose, undo/redo, mute/solo
- Built-in synthesized instruments (piano, e-piano, organ, guitar, strings, basses, leads,
  kick, snare, clap, hi-hats, tom, crash, cowbell) – new songs start with the kit loaded
- Load your own samples (WAV/MP3/OGG/FLAC/AIFF, raw 8-bit), drag & drop songs or samples
- *My songs*: every song you change is kept in the browser (IndexedDB) as its own work in
  progress, so switching songs never loses anything – no account needed. Signed-in users can
  save songs to their account too
- Passwordless sign-in: email → 6-digit code (pasting the code signs you in automatically)
- Playlists of your saved songs: share by link (public) or invite specific email addresses
  (private – they sign in with that address to listen). Songs play in the tracker so you see
  them scroll; **✎ Edit** turns the playing song into your own copy right away

Planned: S3M, STM and IT import, envelope editor, instrument synthesis editors.

## Running

```sh
cp .env.example .env     # fill in SMTP_PASS (and the real SMTP_USER)
docker compose up -d --build
```

The container joins the external `nginx-network` and only **exposes** port 80 – nothing is bound on
the host. Locally, browse to the container IP:

```sh
docker inspect discotracker --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
```

(On Docker Desktop for Mac/Windows container IPs aren't routable from the host; use the nginx
proxy or a Linux host.)

In production the nginx reverse proxy reaches it by container name:

```nginx
location / {
    proxy_pass http://discotracker:80;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # enables Secure cookies over https
    client_max_body_size 40m;                      # song uploads
}
```

### Canonical host (www → naked domain)

Set `CANONICAL_HOST` in `.env` and the app itself redirects every other hostname to it with a
`301` (so it works behind the shared nginx without any special config there):

```sh
CANONICAL_HOST=https://discotracker.com   # www.discotracker.com/x -> https://discotracker.com/x
CANONICAL_HOST=discotracker.com           # same, but keeps http/https as requested
```

The `https://` form also redirects plain http to https, but only when the proxy sends
`X-Forwarded-Proto` (otherwise it could loop). Access by IP or `localhost` and `/healthz` are
never redirected, and the start page gets a matching `<link rel="canonical">`.

Data (SQLite: users, sessions, login codes, saved songs) lives in the `discotracker-data` volume.

## Development

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`).

```sh
npm install
DATA_DIR=./data PORT=3000 npm start   # without SMTP_HOST the login code is printed to the log
npm test                              # replayer + MOD/XM round-trip tests
```

The frontend is plain ES modules with no build step (`public/`):

| Path | |
|---|---|
| `js/song.js` | internal song model (superset of MOD/XM) |
| `js/formats/` | MOD and XM loaders/writers – add S3M/STM/IT here |
| `js/audio/replayer.js` | replayer + mixer (runs in the worklet and in Node tests) |
| `js/instruments/presets.js` | built-in synthesized instruments |
| `js/ui/` | pattern editor, sign-in, My songs |
