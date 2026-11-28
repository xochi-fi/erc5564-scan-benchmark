import { describe, expect, test } from 'bun:test';
import { parseCsv } from '../src/figures/data.ts';
import { renderTables } from '../src/figures/tables.ts';
import { FIGURES } from '../src/figures/figures.ts';

describe('figures and tables', () => {
  test('parseCsv handles quoted fields, commas and doubled quotes', () => {
    expect(parseCsv('a,b,c\n"x, y","say ""hi""",3\n')).toEqual([{ a: 'x, y', b: 'say "hi"', c: '3' }]);
  });

  test('every table renders from recorded data', () => {
    const files = renderTables();
    expect([...files.keys()].sort()).toEqual(
      ['docs/browser-discovery.md', 'docs/chain-volume.md', 'docs/omission-cause.md', 'docs/paged-discovery.md', 'docs/rpc-recovery.md', 'docs/scan-cost.md', 'docs/shared-feed.md', 'docs/spam-cost.md']);
  });

  test('every figure is a standalone SVG with light and dark styles', () => {
    for (const render of Object.values(FIGURES)) {
      const svg = render();
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).toContain('prefers-color-scheme: dark');
      expect(svg).not.toContain('NaN');
    }
  });

  test('scan-vs-volume names its tick rows and the largest real history', () => {
    const svg = FIGURES['scan-vs-volume.svg']!();
    for (const label of ['Real chains, total announcements to date', 'ERC-5564 Announcer', 'Umbra contract', 'Umbra on Polygon PoS']) {
      expect(svg).toContain(label);
    }
    expect(svg).toContain('extrapolated at the per-announcement rate');
    expect(FIGURES['scan-budget.svg']!()).toContain('Real chains, average announcements per day to date');
  });
});
