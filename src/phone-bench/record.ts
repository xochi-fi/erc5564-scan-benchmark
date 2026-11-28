// `bun run phone-bench:record RESULT.json`: checks a result pasted from the bench page and stores it as
// data/phone-bench/<startedAt>-<device>.json. Rejects results that failed the oracle or ran another fixture.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { PHONE_PACKED_SHA256, PHONE_SEED } from './build.ts';

export const resultSchema = z.object({
  kind: z.literal('phone-bench'), pageVersion: z.string(), startedAt: z.string().datetime(),
  device: z.string().min(1, 'fill in the device model'), jit: z.enum(['on', 'off-lockdown', 'off-other', 'unknown']),
  notes: z.string().nullable(), userAgent: z.string(), hardwareConcurrency: z.number().nullable(), secureContext: z.boolean(),
  engine: z.string(), count: z.number().int().positive(), chunk: z.number().int().positive(),
  seed: z.literal(PHONE_SEED), fixtureSha256: z.string(), packedSha256: z.literal(PHONE_PACKED_SHA256),
  scanMs: z.number().positive(), msPerAnnouncement: z.number().positive(),
  matches: z.number().int(), expectedMatches: z.number().int(), verified: z.literal(true),
}).strict().refine(r => r.matches === r.expectedMatches, 'match count differs from the oracle');

if (import.meta.main) {
  const [path, ...rest] = Bun.argv.slice(2);
  if (!path) throw new Error('usage: bun run phone-bench:record RESULT.json [--source "who ran it"]');
  const source = rest[0] === '--source' ? rest[1] ?? null : null;
  const result = resultSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const slug = result.device.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dir = new URL('../../data/phone-bench/', import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${result.startedAt.replace(/[:.]/g, '-')}-${slug}-${result.engine}-${result.jit}.json`;
  writeFileSync(file, `${JSON.stringify({ ...result, recordedAt: new Date().toISOString(), source }, null, 2)}\n`);
  console.log(`recorded ${file}`);
}
