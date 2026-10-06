/**
 * Records real mainnet upstream responses for the replay tests in test/.
 * Usage: npx tsx scripts/record-fixtures.ts
 * Writes test/fixtures/upstream/<scenario>.json.gz and the adapter output to
 * test/fixtures/expected/<scenario>.json (reviewed against the independent
 * reference rebuild before being committed).
 */
import fs from "node:fs";
import path from "node:path";
import { getEvents } from "../src/events.js";
import { setPairsForTest } from "../src/pairs.js";
import { configureUpstream, fetchTransport } from "../src/upstream.js";
import { FIXTURES, recordingTransport, saveRecording, type Recording } from "../test/helpers.js";

export const SCENARIOS: Array<{ name: string; from: number; to: number; note: string }> = [
  { name: "curve-buy-sell", from: 30710200, to: 30710310, note: "WESO curve buy 72983185 + burn/sell 746A91D1" },
  { name: "juris-router", from: 30706080, to: 30706090, note: "JURIS swap routed via router (maker = signer), txIndex 5" },
  { name: "juris-chancla", from: 30696758, to: 30696758, note: "direct JURIS->CWLUNC swap with chancla tax + vault hydration" },
  { name: "juris-big-block", from: 30694741, to: 30694741, note: "JURIS swap at txIndex 84 of 87 (old adapter reported reserve1 18380141.07)" },
  { name: "empty-range", from: 30710311, to: 30710320, note: "valid range with no events" },
];

async function main() {
  const only = process.argv.slice(2);
  for (const sc of SCENARIOS) {
    if (only.length && !only.includes(sc.name)) continue;
    const rec: Recording = {};
    configureUpstream({ transport: recordingTransport(fetchTransport, rec) });
    setPairsForTest(null);
    const events = await getEvents(sc.from, sc.to);
    saveRecording(sc.name, rec);
    const dir = path.join(FIXTURES, "expected");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sc.name}.json`), JSON.stringify({ ...sc, events }, null, 2) + "\n");
    console.log(`${sc.name}: ${events.length} events, ${Object.keys(rec).length} upstream responses`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
