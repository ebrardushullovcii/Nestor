# Nestor website

The public landing page, live at https://trynestor.netlify.app. Plain HTML, CSS and JS with no build step and no `package.json`, so the pnpm workspace ignores it.

- `index.html`, `style.css`, `script.js`: the page.
- `assets/`: screenshots and the tour video from the app, run with fictional sample data.
- The two "Get early access" forms post to Netlify Forms (`early-access`). Submissions are in the Netlify dashboard under the `nestor` project, in Forms.
- `netlify.toml`: publishes this folder as-is and skips deploys for commits that don't touch it.

Preview locally with any static server, for example `python3 -m http.server` in this folder.
