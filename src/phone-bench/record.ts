// `bun run phone-bench:record FILE [--issue] [--author LOGIN]`: validates a phone bench result (a JSON file,
// or with --issue the body of a "Phone bench result" issue) and writes it to data/phone-bench/. Exits 1 with
// the reasons when the result is rejected. Checks what can be checked: schema, pinned fixture digests, the
// oracle, and plausible ranges. A fabricated timing that passes these checks cannot be detected.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { PAGE_VERSION, PHONE_COUNT, PHONE_MATCH_EVERY, PHONE_PACKED_SHA256, PHONE_SEED } from './build.ts';

export const PHONE_FIXTURE_SHA256 = '63ea0c665c7c8a98fe1643ccddc979c2407fc7748aad87e3addd091c8ff50444';
const text = (max: number) => z.string().max(max);

export const resultSchema = z.object({
  kind: z.literal('phone-bench'), pageVersion: z.enum(['4', '5', '6', '7', PAGE_VERSION]), startedAt: z.string().datetime(),
  device: text(80).min(1), os: text(60), browser: text(60), jit: z.enum(['on', 'off-lockdown', 'off-other', 'unknown']), notes: text(200).nullable(),
  detected: z.object({
    os: text(40), osVersion: text(40).nullable(), browser: text(40), browserVersion: text(40).nullable(), device: text(80), app: text(60).nullable(),
    deviceCandidates: z.array(text(120)).max(10), jitGuess: z.enum(['on', 'off-lockdown', 'unknown']), jitReason: text(120),
    uaChModel: text(80).nullable(), uaChPlatform: text(40).nullable(), uaChPlatformVersion: text(40).nullable(),
  }).strict(),
  userAgent: text(400), screen: z.object({ width: z.number().int().positive().max(10000), height: z.number().int().positive().max(10000), devicePixelRatio: z.number().positive().max(10) }).strict(),
  hardwareConcurrency: z.number().int().positive().max(512).nullable(), webAssembly: z.boolean(), secureContext: z.boolean(), worker: z.boolean(),
  engine: z.enum(['crypto', 'sdk', 'wasm']), count: z.union([z.literal(1000), z.literal(5000), z.literal(10000), z.literal(100000)]), chunk: z.union([z.literal(250), z.literal(10)]),
  seed: z.literal(PHONE_SEED), fixtureSha256: z.literal(PHONE_FIXTURE_SHA256), packedSha256: z.literal(PHONE_PACKED_SHA256),
  scanMs: z.number().positive(), msPerAnnouncement: z.number().min(0.05).max(2000),
  matches: z.number().int(), expectedMatches: z.number().int(), verified: z.literal(true),
}).strict().superRefine((r, ctx) => {
  const expected = Math.floor((r.count - 1) / PHONE_MATCH_EVERY) + 1;
  if (r.count > PHONE_COUNT && r.engine !== 'wasm') ctx.addIssue({ code: 'custom', message: 'counts above the fixture repeat it and are for the wasm engine only' });
  if (r.matches !== expected || r.expectedMatches !== expected) ctx.addIssue({ code: 'custom', message: `matches must equal the fixture schedule (${expected})` });
  if (Math.abs(r.scanMs / r.count - r.msPerAnnouncement) > 0.001 + r.msPerAnnouncement * 0.001) ctx.addIssue({ code: 'custom', message: 'msPerAnnouncement does not equal scanMs / count' });
  if (Date.parse(r.startedAt) > Date.now() + 86_400_000) ctx.addIssue({ code: 'custom', message: 'startedAt is in the future' });
  if (r.jit === 'off-lockdown' && r.webAssembly) ctx.addIssue({ code: 'custom', message: 'labelled Lockdown Mode, but WebAssembly was available, so Lockdown was not active' });
});
export type PhoneResult = z.infer<typeof resultSchema>;

/** Extracts the result JSON and the credit checkbox from an issue-form body. */
export function fromIssue(body: string): { json: string; credit: boolean } {
  const block = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(body);
  const json = block?.[1] ?? body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1);
  return { json, credit: /- \[[xX]\] Record my GitHub handle/.test(body) };
}

export function validate(json: string): { ok: true; result: PhoneResult } | { ok: false; errors: string[] } {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return { ok: false, errors: ['not valid JSON'] }; }
  const parsed = resultSchema.safeParse(value);
  return parsed.success ? { ok: true, result: parsed.data } : { ok: false, errors: parsed.error.issues.map(i => `${i.path.join('.') || 'result'}: ${i.message}`) };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const path = args.find(a => !a.startsWith('--') && !['--author', '--source'].includes(args[args.indexOf(a) - 1]!));
  if (!path) throw new Error('usage: bun run phone-bench:record FILE [--issue] [--author LOGIN] [--source LABEL]');
  const raw = readFileSync(path, 'utf8');
  const { json, credit } = args.includes('--issue') ? fromIssue(raw) : { json: raw, credit: args.includes('--author') };
  const checked = validate(json);
  if (!checked.ok) { console.log(`Rejected:\n${checked.errors.map(e => `- ${e}`).join('\n')}`); process.exit(1); }
  const author = args.includes('--author') ? args[args.indexOf('--author') + 1] : undefined;
  const result = checked.result;
  // Credit only on opt-in, and only the account that submitted it.
  // Credit: the submitter's handle on opt-in, or a maintainer's --source label for results recorded by hand.
  const source = args.includes('--source') ? args[args.indexOf('--source') + 1] ?? null : credit && author ? `@${author}` : null;
  const slug = result.device.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const dir = new URL('../../data/phone-bench/', import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${result.startedAt.replace(/[:.]/g, '-')}-${slug}-${result.engine}-${result.count}-${result.jit}.json`;
  writeFileSync(file, `${JSON.stringify({ ...result, source }, null, 2)}\n`);
  console.log(`Accepted: ${file.slice(file.indexOf('data/'))}`);
}
