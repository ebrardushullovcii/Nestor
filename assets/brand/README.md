# Nestor brand assets

This directory is the source of truth for the Nestor branding. Keep the approved vectors, platform exports and export scripts here. Exploration sheets stay outside the repo. Lettering is outlined, so no font installation is needed.

## Concept

The mark is a bold O containing three organic stones. The ring and bottom stone use ink, the middle stone uses stone blue, and the top stone uses stone sage. Keep this original mark on app icons, favicons, tray icons and other symbol-only surfaces.

The wordmark is uppercase NESTOR with the stones mark replacing its O. The N, O mark and R use the original glyph outlines. E, S and T are drawn to match their heavy uppercase lettering, cap height, square terminals and tight optical spacing. All lettering is outlined; the SVGs contain no fonts.

The light palette is ink `#20262D`, stone blue `#3E5979` and stone sage `#839889`. On dark surfaces these become `#FFFFFF`, `#91ACC9` and `#A9BCAA`. Monochrome variants use only black or white. Desktop tiles use the original white background and grey edge; social images use ivory `#F5F2EB`.

## Choose the file for the surface

| Use | File | Background |
| --- | --- | --- |
| Website header or in-app branding | `in-app/wordmark.svg` | Transparent |
| Header on a dark surface | `in-app/wordmark-on-dark.svg` | Transparent; white lettering |
| Standalone symbol | `in-app/mark.svg` | Transparent, including the gaps between the ring and stones |
| Symbol on a dark surface | `in-app/mark-on-dark.svg` | Transparent; lighter foreground |
| Monochrome printing or tinting | `in-app/mark-monochrome.svg`, `in-app/wordmark-monochrome.svg` | Transparent |
| Browser favicon | `web/favicon.svg`, `web/favicon.ico` | Transparent; SVG adapts to light/dark mode |
| PNG favicon fallback | `web/favicon-16.png` through `favicon-128.png` | Transparent |
| iPhone/iPad home-screen shortcut | `web/apple-touch-icon.png` | Opaque white square, 180 × 180; system clips corners |
| Web app icon | `web/icon-192.png`, `web/icon-512.png` | Rounded white tile; outside corners transparent |
| Web app maskable icon | `web/icon-maskable-192.png`, `web/icon-maskable-512.png` | Fully opaque white square; mark inside safe zone |
| Windows executable, taskbar, shortcuts or installer | `desktop/windows/icon.ico` | White tile; outside corners transparent |
| macOS Electron app / Dock / Finder | `desktop/macos/icon.icns` | White tile; outside corners transparent |
| macOS source representations | `desktop/macos/Nestor.iconset/` | 1× and 2× sizes through 1024 pixels |
| Apple app-store image | `desktop/macos/apple-app-store-1024.png` | Opaque white square; no baked corner mask |
| Apple Icon Composer inputs | `desktop/macos/icon-composer-background.png`, `icon-composer-foreground.png` | Separate opaque background and transparent foreground |
| Linux launcher icon | `desktop/linux/` | PNG sizes 16–1024; transparent outside tile |
| Electron/macOS menu-bar template | `in-app/tray-template.png`, `tray-template@2x.png` | Black monochrome with transparent background; use as template image |
| Windows/Linux tray on dark backgrounds | `in-app/tray-white-16.png`, `tray-white-32.png` | White monochrome with transparent background |
| Social link preview | `social/og-image.jpg` or `og-image.png` | Opaque ivory, 1200 × 630; centered NESTOR wordmark |
| Square social image | `social/square.png` | Opaque ivory, 1080 × 1080; centered NESTOR wordmark |

Prefer SVG for page headers and in-app marks. PNG exports are included for applications that require raster images. Do not use the desktop tile as a replacement for the transparent wordmark.

The 16–24 pixel marks, tray icons and small desktop representations use `mark-small*.svg` and `app-icon-small.svg`. These retain the original small-size geometry, with all three stones separated from each other and the ring at 16 pixels.

## Website

Copy the files you need from `web/` into your site's public brand directory. `integration/website-head.html` contains favicon and home-screen-icon tags. `web/icons.webmanifest` supplies icon declarations; merge those into an existing manifest if the site already has one. Adding icons alone does not make a site installable or provide offline behavior.

## Electron

`integration/electron-build/` contains conventional `icon.ico`, `icon.icns`, `icon.png` and `icon.svg` names. Copy these into the desktop project's `build/` directory when integrating. The desktop package points Windows at `build/icon.ico`. The included config snippet shows the paths for Windows, macOS and Linux; merge it into the existing config rather than replacing the config.

For a new native Apple project using Icon Composer, import the separate background and foreground PNGs into Apple's tool and export the resulting `.icon` document there. The included `.icns` is the ready-to-use icon container for the current Electron workflow.

## Source and regeneration

`source/` contains the approved, cleaned vector masters. They use real outlined paths and do not require fonts. Use these sources when changing or exporting the branding.

The final SVGs share one palette and one mark geometry. The desktop tile places that geometry on a white fill with a hairline grey edge. The social images are composed by the export script from `wordmark.svg`, including its stones O.

To re-export, install `sharp` for Node (or point `NESTOR_ASSET_NODE_MODULES` at a `node_modules` folder that contains it) and `Pillow` for Python, then run `node assets/brand/export-assets.cjs` followed by `python3 assets/brand/export-containers.py` from the repo root. The second command also requires macOS `iconutil`. `inventory.json` lists the expected PNG dimensions and transparency.

## Format references

- [Electron Builder icon formats](https://www.electron.build/docs/features/icons-and-images/)
- [Apple app icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons/)
- [MDN web icon and maskable safe-zone guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Define_app_icons)

Copies are installed in `apps/desktop/build/`, `apps/desktop/assets/brand/` and `apps/website/assets/brand/`. Container structure, pixel dimensions, alpha channels, vector content, favicon shape separation (the ring and three stones stay four shapes down to 16 pixels) and the wordmark's six letters plus three stones are checked by the export script. A packaged Windows application has not been tested here.
