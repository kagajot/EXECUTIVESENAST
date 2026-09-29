// Builds demo/landing.html: real app screenshots inlined as data URIs, CTA points at the live demo.
import { readFileSync, writeFileSync } from 'node:fs';
const DEMO_URL = process.argv[2] ?? 'https://claude.ai/artifact/CmUMpbNxL8jv4aqzfody1u';
const img = (n) => 'data:image/png;base64,' + readFileSync(new URL(`assets/${n}.png`, import.meta.url)).toString('base64');
const html = readFileSync(new URL('landing.template.html', import.meta.url), 'utf8')
  .replaceAll('__DEMO_URL__', DEMO_URL).replace('__IMG_HOME__', img('app-home')).replace('__IMG_SAFETY__', img('app-safety'));
writeFileSync(new URL('landing.html', import.meta.url), html);
