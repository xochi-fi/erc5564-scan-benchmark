// samples.jsonl: a run header, then one sample per line with requests as
// [source, operation, status, decodedBytes, wireBytes, cache, edge, fetchMs].
export type Request = {
  source: string; operation: string; status: number; responseBytes: number; wireBytes: number | null;
  cache: string | null; servedBy: string | null; fetchMs: number;
};
type Tuple = [string, string, number, number, number | null, string | null, string | null, number];
export type Sample = Record<string, unknown> & { label: string; requests: Request[] };

const round = (ms: number) => Math.round(ms * 10) / 10;
const toTuple = (r: Request): Tuple =>
  [r.source, r.operation, r.status, r.responseBytes, r.wireBytes, r.cache, r.servedBy, round(r.fetchMs)];
const fromTuple = ([source, operation, status, responseBytes, wireBytes, cache, servedBy, fetchMs]: Tuple): Request =>
  ({ source, operation, status, responseBytes, wireBytes, cache, servedBy, fetchMs });

export function writeSamples(header: Record<string, unknown>, samples: Record<string, Record<string, unknown> & { requests: Request[] }>) {
  return [JSON.stringify(header), ...Object.entries(samples).map(([label, sample]) =>
    JSON.stringify({ label, ...sample, requests: sample.requests.map(toTuple) }))].join('\n') + '\n';
}

export function readSamples(text: string) {
  const [first, ...lines] = text.trim().split('\n');
  const header = JSON.parse(first!) as Record<string, unknown>;
  const samples: Record<string, Sample> = {};
  for (const line of lines) {
    const sample = JSON.parse(line) as Sample & { requests: Tuple[] };
    samples[sample.label] = { ...sample, requests: (sample.requests as unknown as Tuple[]).map(fromTuple) };
  }
  return { header, samples };
}
