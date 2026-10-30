# PadLoop Studio

Worship pads in any key, in your browser. Load a pad sound once and it plays on all twelve keys: press C and it sustains in C, press F and the whole thing slides across to F. Four original pads are built in, so there is something to play the moment you open it.

The app runs entirely in the browser, so there is no server to pay for. Kits and sounds live in a **SQLite database inside your browser**, and the whole thing deploys as a static site to Vercel (or any static host) for free.

| Part     | Tech |
|----------|------|
| App      | Angular 22 (standalone, zoneless, signals), Tailwind CSS v4 |
| Database | SQLite, official WebAssembly build (`@sqlite.org/sqlite-wasm`) in a Web Worker, stored in the browser's Origin Private File System |
| Audio    | Web Audio API |
| Pads     | Synthesised with NumPy — see `tools/make-pads.py` |
| Tests    | Vitest (unit) and GitHub Actions (CI) |
| Hosting  | Vercel Hobby plan (free), deployed from GitHub |

## How it works

1. **Add a sound.** Tap one of the built-in pads (Warm Pad, Air, Strings, Choir) or load your own file — wav, mp3, ogg, m4a, aac, flac or webm, whatever your browser can decode. A kit holds up to 8 sounds.
2. **Press a key.** The sound sustains and loops in that key until you press the key again. There is no play button: the keys are the transport.
3. **Press another key** and everything crossfades across to the new key, so the music never stops abruptly. One key sounds at a time, which is how a pad under a song works.
4. **Layer sounds.** Every sound in the kit plays together, all tuned to the key you pressed. Mute or re-balance them one by one.
5. **Set how long to play.** Pick 5, 10, 15 minutes or anything up to 12 hours (or no limit). The session fades out gently when the time is up.

Keyboard shortcuts: `A W S E D F T G Y H U J` play the twelve keys, `Space` or `Esc` fades out, `←` / `→` skip 10 s (hold `Shift` for 60 s), `Home` goes back to the start.

### Advanced controls

The **Advanced** button in the header reveals the rest: a session timeline, rewind / fast-forward, fade length, the key-lock switch, a level meter, and per-sound tuning (recorded key, octave, fine tune). Everyday playing doesn't need any of it, so it stays out of the way.

**Key lock** is what makes one sound work on twelve keys. Each sound records the key it was played in — read from the file name (`Warm Pad C#m.wav` → C#), detected from the audio, or set by hand — and the app re-tunes it to whichever key you press, always by the shortest route and never more than half an octave. Turn key lock off to hear sounds at their original pitch.

WAV files are measured by reading their header; other formats are decoded once by the browser to find their sample rate and length, so what works follows whatever codecs your browser ships.

## The built-in pads

The four starter pads were synthesised from scratch by `tools/make-pads.py`: no samples and no third-party audio, so they are original works you are free to use, change and redistribute along with the rest of this project.

Each one is a sustained root + fifth + octave drone in C, which sits comfortably under both major and minor chords. Loops are seamless by construction: every oscillator frequency and LFO rate is a whole number of cycles per loop, and the reverb is applied as a circular convolution so its tail wraps back into the start.

```bash
pip install numpy
python3 tools/make-pads.py --check    # re-renders public/pads/*.wav and prints metrics
```

Change the voices in that file to make the pads your own.

### Where is my data?

Your kits live in the browser you used, on that device, and survive closing the browser. They are not synced anywhere.

- A different browser or device starts empty. Use **Kit → Export** and **Kit → Import** to move kits between them.
- Clearing the browser's site data for the app deletes your kits, so export anything you want to keep.
- Private or incognito windows may not keep data; the app says so when that happens.

## Run it on your computer

Requirements: **Node.js 24** (https://nodejs.org).

```bash
npm install
npm start          # http://localhost:4200
npm test           # unit tests
npm run build      # production build in dist/browser
```

### In VS Code

1. Open this folder with **File → Open Folder**, and install the recommended extensions when prompted.
2. In a terminal (**Terminal → New Terminal**), run `npm install`. You only need to do this once.
3. Open **Run and Debug** (`Ctrl+Shift+D`), choose **PadLoop (Chrome)** and press ▶.

## Deploy for free (GitHub + Vercel)

**1. Put the code on GitHub**

```bash
git init
git add .
git commit -m "PadLoop Studio"
git branch -M main
git remote add origin https://github.com/<your-username>/padloop-studio.git
git push -u origin main
```

(Or use VS Code's **Source Control** panel, then **Publish to GitHub**.) The CI workflow then runs the tests and a build on every push.

**2. Connect Vercel**

1. Sign up at https://vercel.com with **Continue with GitHub** and choose the free **Hobby** plan.
2. Click **Add New… → Project**, then **Import** your repository.
3. Leave the settings alone — `vercel.json` already sets the build command, the output folder and the caching headers.
4. Click **Deploy**. After about a minute you get a free `https://<name>.vercel.app` address.

Every push to `main` redeploys, and pull requests get their own preview links. Other free static hosts (GitHub Pages, Netlify, Cloudflare Pages) work too: serve `dist/browser`, no special headers needed.

## Under the hood

```
UI (Angular signals) ──► StudioStore ──► LibraryService ──postMessage──► SQLite worker (OPFS)
                              │
                              └──► AudioEngineService (Web Audio)
```

**Storage**
- SQLite runs in a Web Worker on the `opfs-sahpool` VFS, which needs no COOP/COEP headers and so works on any static host.
- Tables: `kit`, `sound` and `audio_blob`. Audio is stored once per distinct file, keyed by a SHA-256 of its bytes, so the same sound in several kits costs nothing extra.
- Kits export to a single `.padkit` file that carries each sound's bytes and settings, so a kit moves between devices whatever format its sounds are in.
- Schema changes go through the migration list in `src/app/storage/schema.ts`, tracked with `PRAGMA user_version`.

**Audio**
- Signal path: source (looping) → sound gain → key bus → session gain → master → limiter → analyser → speakers.
- Pressing a key builds a new bus for that key and crossfades the old one out, so key changes are smooth.
- Each sound keeps a *phase anchor* — where it was in its loop at a given moment on the session timeline — so loops stay in phase through key changes, pauses and seeks.
- Pitch shifting uses `playbackRate = 2^(semitones/12)`, like a classic sampler. Speed moves with pitch, which sustained pads hide well.
- The session fade is scheduled on the audio clock, so it still ends on time when the tab is in the background.

## Project layout

```
src/app/audio/     engine, loop/phase maths, key detection (+ tests)
src/app/storage/   SQLite worker, schema, library service, audio formats, .padkit format (+ tests)
src/app/state/     app state (signals)
src/app/ui/        keyboard, sound list, status bar
public/pads/       the four built-in pads
tools/make-pads.py the synthesiser that renders them
vercel.json        Vercel build + caching config
.github/workflows  CI (tests + build)
```
