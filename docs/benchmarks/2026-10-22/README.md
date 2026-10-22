# Storage measurement: 2026-10-22

At 100,000 generated events (about 104 MB), the candidate reads a recent window without parsing the entire conversation. Appending one small event writes its new segment and metadata, without rewriting any committed segment.

Both implementations ran sequentially on the same Linux x64 GitHub runner (16 GiB RAM), Node 24.16.0. Baseline: immutable `v0.3.24-jay.39` source. Candidate: `9eb5edaddd1f871db99f1b23c40a92a6677f6154`. [Complete CI run](https://github.com/Biogod2020/dsh-ssh/actions/runs/39821728594).

| 100,000 events | Baseline p50 / p95 | Candidate p50 / p95 |
| --- | --- | --- |
| Read latest 100 records (ms), 100 samples | 563.98 / 569.81 | 3.58 / 5.03 |
| Append one event (ms), 30 samples | 1290.53 / 1307.32 | 5.60 / 6.46 |
| Application bytes written per append | 104,230,510 / 104,232,274 | 1,014 / 1,014 |
| Reconstruct store and read window (ms), 30 samples | 568.49 / 607.52 | 14.13 / 16.10 |

Both runs reported zero failures. Unchanged local validation wrote zero bytes in both implementations. The candidate's recent window read about 521 KB of event segments; the baseline read about 104 MB. Complete timing, read/write totals and maxima for 10,000 and 100,000 events are preserved in the adjacent JSON files.

These are local store operations, with GC before each untimed sample and the operating system's file cache retained. IO counters measure application bytes including metadata, rather than physical SSD writes. Restart means reconstructing the store object, rather than restarting the full app or flushing OS caches. This benchmark does not measure native click-to-render latency, complete SSH traffic, model performance or WAN recovery. Those remain separate acceptance checks.

Reproduce from this candidate checkout after saving the baseline cache source to a separate `.ts` file:

```sh
git show v0.3.24-jay.39:src/remote/history-cache.ts > /tmp/dsh-history-baseline.ts
node --expose-gc --experimental-transform-types scripts/history-store-benchmark.mjs /tmp/dsh-history-baseline.ts 100000 100
node --expose-gc --experimental-transform-types scripts/history-store-benchmark.mjs "$PWD/src/remote/history-store.ts" 100000 100
```

The scripts use disposable generated data and no model or user conversations. macOS preliminary observations are recorded separately in the implementation progress log; they are not pooled with these Linux measurements.
