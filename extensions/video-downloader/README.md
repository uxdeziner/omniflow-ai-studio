# OmniFlow Video Saver

A Chrome extension that finds where the video you are watching really comes from, downloads it
from that source, and saves one complete file with sound.

## Install (personal use)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (`extensions/video-downloader`).
4. Pin the extension to the toolbar.

Loaded this way, every feature is on, including record mode on YouTube.

## Use

- **On the video:** move the mouse over a playing video and click the **Download** button that
  appears in its top-left corner.
- **From the toolbar:** click the extension icon. It lists the videos found in the current tab,
  with a quality picker, **Download** and **Audio only**.
- **Record mode:** for sites that hide their stream (YouTube, some embedded players). Click
  **Record mode** in the popup. The page reloads, the video plays muted at 4x speed, and the
  stream is saved as it plays. Keep the tab open until the "Saved" message appears.

Files go to your normal Downloads folder. Nothing is uploaded anywhere; the extension talks only
to the sites you are already watching.

## How it finds the video

| Method | What it does | Used for |
| --- | --- | --- |
| Network watching | Looks at each media response the tab receives and recognises direct video files, HLS playlists (`.m3u8`) and DASH manifests (`.mpd`). Thumbnails, short previews and individual stream segments are filtered out. | Every site |
| Site data | Reads the video addresses out of the data the site loads for its own player. | X/Twitter, Instagram, Threads, Facebook, TikTok, Reddit |
| Record mode | Copies the media the page feeds to its player while it plays. | YouTube, players with no addressable stream |

Downloading then happens in a background page:

- Streams are fetched segment by segment (6 at a time, with retries), AES-128 encrypted HLS is
  decrypted, and separate audio and video tracks are merged.
- Requests carry the page as Referer, so hotlink-protected media servers answer.
- A file is only saved after it has been opened and checked: it must contain video, have a real
  duration, and match the length the stream announced. Empty files, web pages returned in place
  of video, and truncated downloads are rejected with a message instead of being saved.

## What it does not do

- **DRM-protected video** (Netflix, Prime Video, Disney+, Spotify and similar) is detected and
  refused. Those streams are encrypted, and the extension does not attempt to break that.
- It does not get around logins or paywalls. It can save what your browser can already play.
- Live streams: only the part available at that moment is saved (record mode saves until you
  press Stop).
- Players that run their streaming code in a web worker cannot be recorded.

## Two editions

Chrome Web Store policy does not allow extensions that save YouTube videos, so there are two
builds from the same code:

```bash
npm run build
```

- `dist/omniflow-video-saver-store.zip` is the Web Store edition. YouTube is switched off
  completely (nothing is detected, offered or recorded there).
- `dist/omniflow-video-saver-personal.zip` is the full edition for loading unpacked.

The switch is `youtube` in `config.js`.

Before publishing, expect a longer review: the extension asks for access to all sites and for
`webRequest`, which is what a downloader needs but always draws scrutiny. The store listing
needs a privacy statement (no data is collected or sent anywhere).

## Tests

```bash
npm run test:media
```

```bash
npm test
```

`test:media` generates synthetic clips with ffmpeg in every delivery format. `npm test` loads the
extension into Chromium (Playwright), opens local pages that deliver video the way real sites do,
downloads through the extension, and checks every saved file with ffprobe (all frames present,
sound present, right duration, decodes without errors). To test the Web Store edition:

```bash
EXT_DIR=$PWD/dist/store EXPECT_YOUTUBE_BLOCKED=1 npm test
```

Covered: direct MP4, Referer-protected MP4, HLS (MPEG-TS, fMP4 with separate audio, AES-128),
DASH (segment template, single-file tracks), split audio/video files, audio only, the site-data
readers, the on-video button, the popup, and record mode including a mid-stream quality switch.

The site-data readers are tested against local pages that imitate each site's data shape, not
against the live sites. Sites change these shapes from time to time; when one stops being
recognised, network watching and record mode still apply, and the reader in `content/hook.js`
is the place to update.

## Layout

```
manifest.json      extension manifest (MV3)
config.js          build switches
background.js      detection, per-tab list, download coordination
offscreen.js       download engine (fetch, decrypt, merge, verify)
lib/               HLS and DASH parsers, network helpers, remuxer
content/hook.js    page-world script: site data readers, record-mode capture
content/content.js on-video button, progress messages, record-mode driver
popup/             toolbar popup
vendor/            Mediabunny (MPL-2.0), used to read and write media containers
```

## Responsible use

Save only videos you own or have permission to keep. Downloading may be against a site's terms
of service, and redistributing other people's content can infringe copyright.
