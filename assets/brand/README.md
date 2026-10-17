# Nestor brand assets

This directory is the source of truth for the Nestor branding. Keep the approved vectors, platform exports and export scripts here. Exploration sheets stay outside the repo. Lettering is outlined, so no font installation is needed.

## Concept

Nestor is the wise old counsellor of the Iliad: the steady voice people turn to before a big step. The mark is a doorway onto a horizon. An arched frame in ink holds the sky in stone blue and land at the threshold in stone sage. It suggests a calm, trusted way through to what comes next, which is the role the app plays in a job search and in a live conversation. The shapes are plain arcs and rectangles with even gaps, so the mark stays quiet and still reads at 16 pixels, in one colour as a tray template, and on a tile.

The wordmark is uppercase NESTOR, drawn for this logo as outlined paths: even stems, slightly lighter horizontals, round letters that overshoot the cap height a little, and open spacing. It is one colour with no accent, so the light and monochrome variants are the same artwork, as are the dark and white variants. The palette is ink `#20262D`, stone blue `#3E5979` and stone sage `#839889` on ivory `#F5F2EB`, with `#FFFFFF`, `#91ACC9` and `#A9BCAA` on dark surfaces. These match the app's `--brand-stone-blue` and `--brand-stone-sage` variables.

## Choose the file for the surface

| Use | File | Background |
| --- | --- | --- |
| Website header or in-app branding | `in-app/wordmark.svg` | Transparent |
| Header on a dark surface | `in-app/wordmark-on-dark.svg` | Transparent; white lettering |
| Standalone symbol | `in-app/mark.svg` | Transparent, including the gaps between frame, sky and land |
| Symbol on a dark surface | `in-app/mark-on-dark.svg` | Transparent; lighter foreground |
| Monochrome printing or tinting | `in-app/mark-monochrome.svg`, `in-app/wordmark-monochrome.svg` | Transparent |
| Browser favicon | `web/favicon.svg`, `web/favicon.ico` | Transparent; SVG adapts to light/dark mode |
| PNG favicon fallback | `web/favicon-16.png` through `favicon-128.png` | Transparent |
| iPhone/iPad home-screen shortcut | `web/apple-touch-icon.png` | Opaque ivory square, 180 × 180; system clips corners |
| Web app icon | `web/icon-192.png`, `web/icon-512.png` | Rounded ivory tile; outside corners transparent |
| Web app maskable icon | `web/icon-maskable-192.png`, `web/icon-maskable-512.png` | Fully opaque ivory square; mark inside safe zone |
| Windows executable, taskbar, shortcuts or installer | `desktop/windows/icon.ico` | Ivory tile; outside corners transparent |
| macOS Electron app / Dock / Finder | `desktop/macos/icon.icns` | Ivory tile; outside corners transparent |
| macOS source representations | `desktop/macos/Nestor.iconset/` | 1× and 2× sizes through 1024 pixels |
| Apple app-store image | `desktop/macos/apple-app-store-1024.png` | Opaque ivory square; no baked corner mask |
| Apple Icon Composer inputs | `desktop/macos/icon-composer-background.png`, `icon-composer-foreground.png` | Separate opaque background and transparent foreground |
| Linux launcher icon | `desktop/linux/` | PNG sizes 16–1024; transparent outside tile |
| Electron/macOS menu-bar template | `in-app/tray-template.png`, `tray-template@2x.png` | Black monochrome with transparent background; use as template image |
| Windows/Linux tray on dark backgrounds | `in-app/tray-white-16.png`, `tray-white-32.png` | White monochrome with transparent background |
| Social link preview | `social/og-image.jpg` or `og-image.png` | Opaque ivory, 1200 × 630; mark beside the wordmark |
| Square social image | `social/square.png` | Opaque ivory, 1080 × 1080; mark above the wordmark |

Prefer SVG for page headers and in-app marks. PNG exports are included for applications that require raster images. Do not use the desktop tile as a replacement for the transparent wordmark.

The 16–24 pixel marks, the tray icons and the small desktop representations use `mark-small*.svg` and `app-icon-small.svg`. That geometry puts every straight edge on a 64-unit grid, so at 16 pixels the frame is two pixels wide and each gap is one whole pixel. The master artwork keeps finer proportions for 32 pixels and up.

## Website

Copy the files you need from `web/` into your site's public brand directory. `integration/website-head.html` contains favicon and home-screen-icon tags. `web/icons.webmanifest` supplies icon declarations; merge those into an existing manifest if the site already has one. Adding icons alone does not make a site installable or provide offline behavior.

## Electron

`integration/electron-build/` contains conventional `icon.ico`, `icon.icns`, `icon.png` and `icon.svg` names. Copy these into the desktop project's `build/` directory when integrating. The desktop package points Windows at `build/icon.ico`. The included config snippet shows the paths for Windows, macOS and Linux; merge it into the existing config rather than replacing the config.

For a new native Apple project using Icon Composer, import the separate background and foreground PNGs into Apple's tool and export the resulting `.icon` document there. The included `.icns` is the ready-to-use icon container for the current Electron workflow.

## Source and regeneration

`source/` contains the approved, cleaned vector masters. They use real outlined paths and do not require fonts. Use these sources when changing or exporting the branding.

The final SVGs share one palette and one mark geometry. The desktop tile places that geometry on an ivory fill with a hairline warm-grey edge. The social images are composed by the export script from `mark.svg` and `wordmark.svg`.

To re-export, install `sharp` for Node (or point `NESTOR_ASSET_NODE_MODULES` at a `node_modules` folder that contains it) and `Pillow` for Python, then run `node assets/brand/export-assets.cjs` followed by `python3 assets/brand/export-containers.py` from the repo root. The second command also requires macOS `iconutil`. `inventory.json` lists the expected PNG dimensions and transparency.

## Format references

- [Electron Builder icon formats](https://www.electron.build/docs/features/icons-and-images/)
- [Apple app icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons/)
- [MDN web icon and maskable safe-zone guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Define_app_icons)

Copies are installed in `apps/desktop/build/`, `apps/desktop/assets/brand/` and `apps/website/assets/brand/`. Container structure, pixel dimensions, alpha channels, vector content, favicon shape separation (frame, sky and land stay three shapes down to 16 pixels) and the wordmark's six letters are checked by the export script. A packaged Windows application has not been tested here.
