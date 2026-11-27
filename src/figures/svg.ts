// Minimal SVG building blocks for docs/figures/. Colors are roles defined once in THEME,
// with light values for GitHub's light theme and dark values under prefers-color-scheme.
// Series colors are slots 1-3 of the dataviz reference palette, validated against
// #ffffff (light) and #0d1117 (dark). Key series carry a direct label or a legend entry
// with a second cue (hollow marks, dashes), so aqua's 2.8:1 light-mode contrast is relieved
// by text or shape, not color alone. Text is 13px or larger; sources and caveats live in the
// Markdown caption under each figure, not in the image.

export const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const THEME = `
  .bg { fill: #ffffff; }
  .ink { fill: #1f2328; }
  .muted { fill: #59636e; }
  .grid { stroke: #d1d9e0; }
  .axis { stroke: #818b98; }
  .gap { stroke: #ffffff; }
  .s1 { fill: #2a78d6; stroke: #2a78d6; }
  .s2 { fill: #eb6834; stroke: #eb6834; }
  .s3 { fill: #1baf7a; stroke: #1baf7a; }
  .band { fill: #818b98; fill-opacity: 0.16; }
  .hollow { fill: #ffffff; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #0d1117; }
    .ink { fill: #f0f6fc; }
    .muted { fill: #9198a1; }
    .grid { stroke: #2f353d; }
    .axis { stroke: #656c76; }
    .gap { stroke: #0d1117; }
    .s1 { fill: #3987e5; stroke: #3987e5; }
    .s2 { fill: #d95926; stroke: #d95926; }
    .s3 { fill: #199e70; stroke: #199e70; }
    .band { fill: #9198a1; fill-opacity: 0.18; }
    .hollow { fill: #0d1117; }
  }
  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; }
  .title { font-size: 18px; font-weight: 600; }
  .label { font-size: 14px; }
  .small { font-size: 13px; }
`;

export function svg(width: number, height: number, title: string, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
    `<style>${THEME}</style>`,
    `<rect class="bg" x="0" y="0" width="${width}" height="${height}" rx="6"/>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

const r = (value: number) => Math.round(value * 10) / 10;

export function text(x: number, y: number, content: string, cls = 'label ink', anchor: 'start' | 'middle' | 'end' = 'start', extra = '') {
  return `<text x="${r(x)}" y="${r(y)}" class="${cls}" text-anchor="${anchor}"${extra}>${esc(content)}</text>`;
}
export const line = (x1: number, y1: number, x2: number, y2: number, cls: string, extra = '') =>
  `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" class="${cls}"${extra}/>`;
export const rect = (x: number, y: number, w: number, h: number, cls: string, tip?: string, extra = '') =>
  `<rect x="${r(x)}" y="${r(y)}" width="${r(Math.max(w, 0))}" height="${r(h)}" class="${cls}"${extra}>${tip ? `<title>${esc(tip)}</title>` : ''}</rect>`;
export const circle = (x: number, y: number, radius: number, cls: string, tip?: string, extra = '') =>
  `<circle cx="${r(x)}" cy="${r(y)}" r="${radius}" class="${cls}"${extra}>${tip ? `<title>${esc(tip)}</title>` : ''}</circle>`;

/** log10 scale from [lo, hi] (both powers of ten) onto [a, b]. */
export function logScale(lo: number, hi: number, a: number, b: number) {
  const l0 = Math.log10(lo);
  const l1 = Math.log10(hi);
  const scale = (value: number) => a + ((Math.log10(value) - l0) / (l1 - l0)) * (b - a);
  const decades = Array.from({ length: Math.round(l1 - l0) + 1 }, (_, i) => 10 ** (Math.round(l0) + i));
  return { scale, decades };
}
export const linearScale = (lo: number, hi: number, a: number, b: number) => (value: number) => a + ((value - lo) / (hi - lo)) * (b - a);

/** 1, 10, 100, 1k, 10k, 100k, 1M; sub-unit powers as 0.1, 0.01, … */
export function decadeLabel(value: number): string {
  if (value >= 1e6) return `${value / 1e6}M`;
  if (value >= 1e3) return `${value / 1e3}k`;
  return String(Number(value.toPrecision(1)));
}

/** Legend row of colored swatches with labels. */
export function legend(x: number, y: number, items: [cls: string, label: string][]) {
  const out: string[] = [];
  let cx = x;
  for (const [cls, label] of items) {
    out.push(rect(cx, y - 11, 12, 12, cls, undefined, ' rx="2"'));
    out.push(text(cx + 18, y, label, 'label ink'));
    cx += 34 + label.length * 7.6;
  }
  return out;
}

/** Legend entry for a filled or hollow dot. Returns the x after it. */
export function dotKey(x: number, y: number, cls: string, label: string, hollow: boolean, out: string[]): number {
  out.push(hollow
    ? circle(x + 6, y - 5, 5, `${cls} hollow`, undefined, ' stroke-width="2.5"')
    : circle(x + 6, y - 5, 6, cls));
  out.push(text(x + 18, y, label, 'label ink'));
  return x + 34 + label.length * 7.6;
}
