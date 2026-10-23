# Local observation metadata: installed-package checks

Candidate archive SHA256: `a9f82b7230b0791b73edc218244d971182a6e2c2702ac1392d6853a689c58ff3`.

| Runtime | Baseline installed gateway/catalog checks | Generated notice save/read/dismiss/late-save fence |
| --- | --- | --- |
| DSH 0.2.1-rc.2 | Passed | Passed |
| DSH 0.2.0-rc.2 | Passed | Not exercised |
| DSH 0.2.1-alpha.4 | Passed | Not exercised |

Each runtime preserves its generated remote PID and uses no model requests. The notice test submits generated ended metadata explicitly; it does not simulate a command failure or verify an automatic operation observer. Serialization checks use a mock Client context, including a synthetic heap value, and are not native memory measurements.

The downgrade report uses this same candidate's packaged exporter and the actual published jay.39 consumer. It verifies 603 retained events and that cleared archives do not revive.

`provenance.json` records the full local test count and exact source/archive parity. `SHA256SUMS` covers all raw reports and provenance. Native Desktop acceptance, automatic memory-based eviction, final-candidate 24-hour stability, registry publication and daily installation are not verified here.
