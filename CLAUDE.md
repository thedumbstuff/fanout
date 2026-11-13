# fanout

Electron app (Windows, macOS, Linux): one window for every brand's social accounts.
Brands have isolated sign-ins, tabs, up to four pages side by side, a file panel to drag
uploads from, a text preview with select-to-copy, a media viewer (video, pictures,
sound; served over `fanout-media:` to the interface only), and a posted tracker. Open source
(MIT) under thedumbstuff. Started 2026-11-12.

Read `README.md`, then `docs/architecture.md`, `docs/memory.md`, `docs/gotchas.md`.
`src/main/main.js` lists what every file is for.

## Rules

- **No automation, ever.** fanout never clicks, types or reads inside a page: no preload
  in tabs, no `executeJavaScript`, no input events outside `tools/smoke.mjs` (and there
  only on the test's own local pages). Owner's rule; most platforms forbid bots.
- **Memory matters to the owner.** Anything that loads pages, files or lists needs a
  bound. Re-run `npm run measure` after touching `tabs.js` or `sleeper.js` and update
  `docs/memory.md`.
- **One runtime dependency** (`electron-updater`, owner approved 2026-11-12), no framework, no bundler. Keep pure logic free of Electron
  so `npm test` can cover it.
- Never use Electron's quit; the only way out is `ctx.shutdown` (see gotchas).
- **Sites see fanout as it is**: Electron's own user agent, unchanged. No disguise as
  Chrome, no rewritten headers, no Chromium switches (Google refuses sign-in from a
  browser that pretends; a unit test guards it). See gotchas.
- Electron 45 is newer than most examples: check `node_modules/electron/electron.d.ts`
  before trusting a remembered API (the clipboard is async now).
- Interface copy: plain words, sentence case, says what happens.

## Working here

```
npm test                       # 44 unit tests
npm run smoke                  # 77 checks on the real app; opens a window (muted)
npm run measure                # memory on six real sites; takes about 2 minutes
npm run screenshots            # README pictures from the real app (sample data); opens a window, about 2 minutes
node node_modules/electron/cli.js tools/media-formats.mjs   # which formats the viewer shows here
node tools/release.mjs build   # installer + update feed in dist/ (notes from docs/changelog.md)
python watchtower/server.py    # http://127.0.0.1:8768  (--once for the terminal)
```

- `roadmap.yaml` is the single source of truth for status; update it and
  `docs/changelog.md` with every change. Commit in small chunks, no trailers.
- Real profile: `%APPDATA%\fanout`. Tests use `FANOUT_USER_DATA` and `.smoke/`.
- Tools that drive Electron open real windows on the owner's desktop; a click there
  during a run changes the result. Anything they play is muted.
- A tool that loads `main.js` with `import()` must first `import '../src/main/mediaprotocol.js'`
  statically (the scheme has to exist before the app is ready; see gotchas).
- The smoke check "a tab with unsaved typing refuses to sleep" (simulated keys) is flaky:
  on 2026-11-13 it failed in 4 of 6 runs, once with the media checks skipped and the
  window and page both reporting focus, and passed in the other two.

## Open

- Owner must sign in to real accounts and do a real drag-and-drop upload: roadmap P5.
  Google refused sign-in while fanout claimed to be Chrome; the honest user agent is in,
  a real Google sign-in is still unproven (D4).
- macOS and Linux builds need CI (repo not pushed yet). Installers are unsigned.
- Updates (`docs/updates.md`): the app side works; nothing can be published until
  thedumbstuff-site's downloads service takes fanout and a file over 100 MB (roadmap P4.3).
- fanout 0.2.0 is installed on the owner's PC at `%LOCALAPPDATA%\Programs\fanout` (2026-11-12).
- Later: caption clipboard (P6.1), thumbnails in the tree (P6.2), tab reordering.
