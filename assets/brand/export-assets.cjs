const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const runtime = process.env.NESTOR_ASSET_NODE_MODULES;
const sharp = runtime ? createRequire(path.join(runtime, '_asset_loader.cjs'))('sharp') : require('sharp');
const root = __dirname;
const inventory = [];
async function render(source, target, width, opaque = false, height) {
  const out = path.join(root, target);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let pipeline = sharp(path.join(root, 'source', source), { density: 384 }).resize(width, height).withIccProfile('srgb');
  if (opaque) pipeline = pipeline.flatten({ background: '#ffffff' }).removeAlpha();
  await pipeline.png({ compressionLevel: 9 }).toFile(out);
  const meta = await sharp(out).metadata();
  inventory.push({ path: target, width: meta.width, height: meta.height, transparent: !opaque, format: 'png' });
}
async function main() {
  for (const n of [16, 32, 48, 64, 128]) await render(n <= 24 ? 'mark-small.svg' : 'mark.svg', `web/favicon-${n}.png`, n);
  for (const n of [16, 32]) await render(n <= 24 ? 'mark-small-on-dark.svg' : 'mark-on-dark.svg', `web/favicon-dark-${n}.png`, n);
  fs.copyFileSync(path.join(root, 'source/favicon-adaptive.svg'), path.join(root, 'web/favicon.svg'));
  await render('app-icon-square.svg', 'web/apple-touch-icon.png', 180, true);
  for (const n of [192, 512]) {
    await render('app-icon.svg', `web/icon-${n}.png`, n);
    await render('maskable-icon.svg', `web/icon-maskable-${n}.png`, n, true);
  }
  for (const n of [16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512, 1024])
    await render(n <= 48 ? 'app-icon-small.svg' : 'app-icon.svg', `desktop/windows/icon-${n}.png`, n);
  for (const n of [16, 32, 128, 256, 512]) {
    await render(n <= 32 ? 'app-icon-small.svg' : 'app-icon.svg', `desktop/macos/Nestor.iconset/icon_${n}x${n}.png`, n);
    await render(n <= 16 ? 'app-icon-small.svg' : 'app-icon.svg', `desktop/macos/Nestor.iconset/icon_${n}x${n}@2x.png`, n * 2);
  }
  for (const n of [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024])
    await render(n <= 48 ? 'app-icon-small.svg' : 'app-icon.svg', `desktop/linux/${n}x${n}.png`, n);
  await render('app-icon-square.svg', 'desktop/macos/apple-app-store-1024.png', 1024, true);
  await render('apple-foreground.svg', 'desktop/macos/icon-composer-foreground.png', 1024);
  await render('apple-background.svg', 'desktop/macos/icon-composer-background.png', 1024, true);
  for (const n of [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    await render(n <= 24 ? 'mark-small.svg' : 'mark.svg', `in-app/mark-${n}.png`, n);
    await render(n <= 24 ? 'mark-small-on-dark.svg' : 'mark-on-dark.svg', `in-app/mark-on-dark-${n}.png`, n);
  }
  for (const variant of ['wordmark', 'wordmark-on-dark', 'wordmark-monochrome', 'wordmark-monochrome-white'])
    for (const n of [320, 640, 1280, 2560]) await render(`${variant}.svg`, `in-app/${variant}-${n}.png`, n);
  for (const [name, source] of [['tray-template', 'mark-small-monochrome.svg'], ['tray-white', 'mark-small-monochrome-white.svg']]) {
    await render(source, `in-app/${name}.png`, 22);
    await render(source, `in-app/${name}@2x.png`, 44);
    await render(source, `in-app/${name}-16.png`, 16);
    await render(source, `in-app/${name}-32.png`, 32);
  }
  for (const name of ['mark', 'mark-on-dark', 'mark-monochrome', 'mark-monochrome-white', 'wordmark', 'wordmark-on-dark', 'wordmark-monochrome', 'wordmark-monochrome-white'])
    fs.copyFileSync(path.join(root, 'source', `${name}.svg`), path.join(root, 'in-app', `${name}.svg`));
  const inner = name => {
    const svg = fs.readFileSync(path.join(root, 'source', name), 'utf8');
    return svg.slice(svg.indexOf('</title>') + 8, svg.lastIndexOf('</svg>'));
  };
  const [, , wordWidth, wordHeight] = fs.readFileSync(path.join(root, 'source/wordmark.svg'), 'utf8').match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  // The mark's artwork spans x 160-864 and y 72-952 of its 1024 canvas.
  const place = (name, x, y, scale, originX, originY) => `<g transform="translate(${x} ${y}) scale(${scale}) translate(${-originX} ${-originY})">${inner(name)}</g>`;
  const card = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#f5f2eb"/>${body}</svg>`;
  // Landscape: mark beside the wordmark, cap height about a third of the mark.
  const markH = 236, markW = markH * 704 / 880, capH = 84, wordW = capH * wordWidth / wordHeight, gapX = 64;
  const startX = (1200 - markW - gapX - wordW) / 2, markY = (630 - markH) / 2;
  fs.writeFileSync(path.join(root, 'source/social-card.svg'), card(1200, 630,
    place('mark.svg', startX, markY, markH / 880, 160, 72) + place('wordmark.svg', startX + markW + gapX, markY + markH - capH - 2, capH / wordHeight, 0, 0)));
  // Square: mark above the wordmark.
  const sqMarkH = 380, sqWordW = 520, sqWordH = sqWordW * wordHeight / wordWidth, sqGap = 96;
  const sqTop = (1080 - sqMarkH - sqGap - sqWordH) / 2;
  fs.writeFileSync(path.join(root, 'source/social-square.svg'), card(1080, 1080,
    place('mark.svg', (1080 - sqMarkH * 704 / 880) / 2, sqTop, sqMarkH / 880, 160, 72) + place('wordmark.svg', (1080 - sqWordW) / 2, sqTop + sqMarkH + sqGap, sqWordW / wordWidth, 0, 0)));
  await render('social-card.svg', 'social/og-image.png', 1200, true, 630);
  await render('social-square.svg', 'social/square.png', 1080, true, 1080);
  await sharp(path.join(root, 'social/og-image.png')).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).withIccProfile('srgb').toFile(path.join(root, 'social/og-image.jpg'));
  await render('mark.svg', 'preview/mark.png', 512);
  await render('app-icon.svg', 'preview/app-icon.png', 512);
  await render('wordmark.svg', 'preview/wordmark.png', 1280);
  fs.writeFileSync(path.join(root, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  console.log(`Exported ${inventory.length} PNG assets individually from shared vector masters.`);
}
main().catch(error => { console.error(error); process.exit(1); });
