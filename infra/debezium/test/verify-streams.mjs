#!/usr/bin/env node
// Verifies one pipeline-test.sh run (task I-03): every committed outbox payload must appear in
// Redis stream changes:<type>, field `value`, with exactly the committed JSON, in commit order per
// type. Duplicates are allowed (at-least-once delivery) but must equal the original.
//
//   node infra/debezium/test/verify-streams.mjs <run> [--wait-seconds 60]
//
// Exit 0 when nothing is missing, out of order or different; 1 otherwise.
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = process.argv[2];
if (!run) {
  console.error('usage: verify-streams.mjs <run> [--wait-seconds N]');
  process.exit(2);
}
const waitIdx = process.argv.indexOf('--wait-seconds');
const waitSeconds = waitIdx > 0 ? Number(process.argv[waitIdx + 1]) : 60;
const compose = [
  'compose',
  '-f',
  fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)),
];
const network = process.env.DRILL_NETWORK ?? 'atlas-realtime_default';

function sql(query) {
  return execFileSync(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      'postgres-primary',
      'psql',
      '-U',
      'postgres',
      '-d',
      'atlas',
      '-Atq',
      '-c',
      query,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
  );
}

function xrange(stream) {
  const out = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      network,
      'redis:7.4',
      'redis-cli',
      '--json',
      '-h',
      'redis-proxy',
      '-p',
      '6380',
      'XRANGE',
      stream,
      '-',
      '+',
    ],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  return JSON.parse(out); // [[id, [field, value, ...]], ...]
}

// Expected payloads, grouped by type.
const expected = new Map(); // type -> Map(seq -> payload)
for (const line of sql(
  `COPY (SELECT type, seq, payload::text FROM pipeline_test.expected WHERE run = '${run.replace(/'/g, "''")}' ORDER BY type, seq) TO STDOUT`,
)
  .split('\n')
  .filter(Boolean)) {
  const [type, seq, payload] = line.split('\t');
  if (!expected.has(type)) expected.set(type, new Map());
  expected.get(type).set(Number(seq), JSON.parse(payload.replace(/\\\\/g, '\\')));
}
const totalExpected = [...expected.values()].reduce((n, m) => n + m.size, 0);
if (totalExpected === 0) {
  console.error(`no expected rows for ${run}`);
  process.exit(1);
}

function check() {
  const report = {
    types: {},
    missing: 0,
    duplicates: 0,
    different: 0,
    outOfOrder: 0,
    latencies: [],
    shape: null,
  };
  for (const [type, bySeq] of expected) {
    const seqs = [...bySeq.keys()];
    const min = Math.min(...seqs);
    const max = Math.max(...seqs);
    const seen = new Map(); // seq -> first payload
    let lastFirstSeen = 0;
    let outOfOrder = 0;
    let duplicates = 0;
    let different = 0;
    for (const [id, fields] of xrange(`changes:${type}`)) {
      const f = Object.fromEntries(
        fields.reduce((acc, v, i) => (i % 2 ? acc : [...acc, [v, fields[i + 1]]]), []),
      );
      report.shape ??= { streamId: id, fields: Object.keys(f) };
      if (f.value === undefined) continue;
      const payload = JSON.parse(f.value);
      const seq = payload.typeSeq;
      if (!bySeq.has(seq) || seq < min || seq > max) continue; // other runs
      if (seen.has(seq)) {
        duplicates++;
        if (!isDeepStrictEqual(seen.get(seq), payload)) different++;
        continue;
      }
      seen.set(seq, payload);
      if (seq < lastFirstSeen) outOfOrder++;
      lastFirstSeen = seq;
      if (!isDeepStrictEqual(bySeq.get(seq), payload)) different++;
      report.latencies.push(Number(id.split('-')[0]) - Date.parse(payload.committedAt));
    }
    const missing = seqs.filter((s) => !seen.has(s));
    report.types[type] = {
      expected: bySeq.size,
      received: seen.size,
      missing: missing.length,
      firstMissing: missing.slice(0, 5),
      duplicates,
      outOfOrder,
      different,
    };
    report.missing += missing.length;
    report.duplicates += duplicates;
    report.different += different;
    report.outOfOrder += outOfOrder;
  }
  return report;
}

const deadline = Date.now() + waitSeconds * 1000;
let report = check();
while (report.missing > 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  report = check();
}

const lat = report.latencies.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
console.log(`run ${run}: ${totalExpected} committed rows`);
console.log(`entry shape: ${JSON.stringify(report.shape)}`);
console.table(report.types);
console.log(
  `commit -> stream entry (Redis XADD time - committedAt): p50 ${pct(50)} ms, p99 ${pct(99)} ms, max ${lat.at(-1)} ms; ` +
    `${lat.filter((l) => l > 1000).length} of ${lat.length} over 1 s`,
);
console.log(
  `missing ${report.missing}, duplicates ${report.duplicates}, out of order ${report.outOfOrder}, payload differs ${report.different}`,
);
const ok = report.missing === 0 && report.outOfOrder === 0 && report.different === 0;
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(ok ? 0 : 1);
