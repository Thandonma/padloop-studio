# PadLoop Studio

A web app for sustained, layered ambient pads. Put WAV samples on 12 pads (C to B), stack up to 8 layers on each pad, and let them loop for as long as you like. Every layer is pitch-shifted automatically so it plays in the pad's key.

The whole app runs in the browser, so there is no server to pay for. Kits and samples are stored in a **SQLite database inside your browser**, and it deploys as a static site to Vercel (or any static host) for free.

| Part     | Tech |
|----------|------|
| App      | Angular 22 (standalone, zoneless, signals), Tailwind CSS v4 |
| Database | SQLite, official WebAssembly build (`@sqlite.org/sqlite-wasm`) running in a Web Worker and stored in the browser's Origin Private File System |
| Audio    | Web Audio API |
| Tests    | Vitest (unit tests) and GitHub Actions (CI) |
| Hosting  | Vercel Hobby plan (free), deployed from GitHub |

## Features

- **12 pads, C to B**, laid out like a piano. Play them with the mouse, touch, or keys `A W S E D F T G Y H U J`.
- **WAV samples.** Drop them on a pad or browse for them. Each file becomes a layer, up to 8 per pad. Files are checked by reading their WAV header. There's no upload size limit, only your browser's storage space.
- **Sustain and loop, as long as you want.** Loops are made seamless with a crossfade, so there's no click. The session length can be 1–120 min, a custom value up to 12 hours, or endless, and the session fades out at the end.
- **Layers.** Arm several pads at once, and each pad can hold several samples. Each layer has its own volume, mute, octave (±2) and fine-tune (±100 cents).
- **Key lock.** Each layer records the key it was played in:
  1. read from the file name (`Warm Pad C#m.wav` → C#), or
  2. detected from the audio (an FFT chromagram matched against Krumhansl–Kessler key profiles), or
  3. set by hand.

  The layer is then shifted onto its pad's key by the shortest route (never more than ±6 semitones).
- **Transport.** Play, pause, resume, stop, back to start, and rewind / fast-forward (5, 10, 30 or 60 s steps), plus a draggable timeline. Every loop stays in phase when you pause or jump around.
- **Two pad modes.** In Latch mode you tap a pad to sustain it and tap again to fade it out. In Hold mode a pad sounds only while you hold it. The fade time is adjustable.
- **Kits.** You can create, rename, switch between and delete kits, and settings save automatically.
- **Export and import.** A kit, including its samples, can be saved as a single `.padkit` file, which you can use as a backup or to move the kit to another browser or device.

Keyboard shortcuts: `Space` plays or pauses, `←` / `→` skip 10 s (hold `Shift` for 60 s), `Home` goes back to the start, and `Esc` stops.

### Where is my data?

Your data lives in the browser you used, on that device, and it survives closing the browser. It isn't synced anywhere. Keep these in mind:

- A different browser or device starts empty. Use **Export** and **Import** to move kits between them.
- Clearing a browser's site data for the app deletes your kits, so export anything you want to keep.
- Private or incognito windows may not keep data. The app shows a notice when that happens.

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
3. Open **Run and Debug** (`Ctrl+Shift+D`), choose **PadLoop (Chrome)** and press ▶. This starts the dev server and opens Chrome with breakpoints working.

## Deploy for free (GitHub + Vercel)

**1. Put the code on GitHub**

1. Create a free account at https://github.com, then click **New repository**.
   - Name it, for example, `padloop-studio`.
   - It can be public or private.
   - Don't add a README.
2. In a terminal inside this folder, run:

   ```bash
   git init
   git add .
   git commit -m "PadLoop Studio"
   git branch -M main
   git remote add origin https://github.com/<your-username>/padloop-studio.git
   git push -u origin main
   ```

   (Or use VS Code's **Source Control** panel, then **Publish to GitHub**.)
3. On GitHub, open the **Actions** tab. The CI workflow runs the tests and a build on every push.

**2. Connect Vercel**

1. Sign up at https://vercel.com with **Continue with GitHub** and choose the free **Hobby** plan.
2. Click **Add New… → Project**, then **Import** your `padloop-studio` repository.
3. Leave the settings as they are. `vercel.json` already sets the build command (`npm run build`), the output folder (`dist/browser`) and Node 24 (through `package.json`).
4. Click **Deploy**. After about a minute you get a free `https://<name>.vercel.app` address.

From then on, every `git push` to `main` redeploys the site automatically, and pull requests get their own preview links.

Other free static hosts, such as GitHub Pages, Netlify or Cloudflare Pages, also work. Serve the `dist/browser` folder. The site needs no special headers.

## How it works

```
UI (Angular signals) ──► StudioStore ──► LibraryService ──postMessage──► SQLite worker (OPFS)
                              │
                              └──► AudioEngineService (Web Audio)
```

**Storage**
- SQLite runs in a Web Worker using the `opfs-sahpool` VFS. Unlike the plain OPFS VFS, it needs no COOP/COEP headers, so it works on any static host.
- The tables are `kit`, `layer` and `sample`. WAV bytes live in `sample`, so listing layers never touches large data.
- The schema is updated through migrations in `src/app/storage/schema.ts`, tracked with `PRAGMA user_version`.

**Audio**
- The audio chain is: source (looping) → layer gain → pad gain → session gain → master → limiter → analyser → speakers.
- Each layer keeps a *phase anchor*, so it knows its exact loop offset at any point on the timeline. That is what keeps loops in phase through pause, resume, rewind, fast-forward and retuning.
- Pitch shifting uses `playbackRate = 2^(semitones/12)`, like a classic sampler. Speed changes with pitch, which pads and long textures hide well.
- The session fade is scheduled on the audio clock, so it still ends on time when the tab is in the background.

## Project layout

```
src/app/audio/     engine, loop/phase maths, key detection (+ tests)
src/app/storage/   SQLite worker, schema, library service, WAV parser, .padkit format (+ tests)
src/app/state/     app state (signals)
src/app/ui/        components: transport, pad grid, pad inspector
vercel.json        Vercel build + caching config
.github/workflows  CI (tests + build)
```
