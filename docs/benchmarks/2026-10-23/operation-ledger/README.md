# Operation-release core and actual SDK contract probe

Candidate SHA-256: `f53508849cbbb472381a8f8e3edf9f8bc42a0f91f552591efd97c37d1a221748`; occupied jay.39 label remains for isolated development only.

- [Provenance](provenance.json): 101 source files byte matched; 98 files / 904 tests, typecheck, build, artifact and pure-JS packaging passed. The three executable JS files are byte-identical to the previous native-verified candidate because the new core is not wired into the Client yet.
- [SDK unary probe](operation-rpc-contract-verified-rc21.json): unmodified shipped rc.2 SDK factory, mock public Context and HTTP responses. Header arrival, delayed binary decode, mismatched RPC identity, post-dispatch abort, validated business refusal and a real local metadata-store restart are verified. This is not real page boot/Host/native acceptance.
- Installed-archive baseline checks: [rc.2](operation-ledger-runtime-rc21.json), [0.2.0-rc.2](operation-ledger-runtime-rc20.json), [alpha.4](operation-ledger-runtime-alpha4.json); [published jay.39 downgrade](operation-ledger-downgrade.json). These do not exercise a live operation observer, gateway freeze or eviction.

Reproduce the SDK-only contract probe:

```sh
node --experimental-transform-types scripts/operation-rpc-contract.mjs ABSOLUTE_SDK_CLIENT_BROWSER_JS NEW_PRIVATE_REPORT
```

Use the actual installed `@deepseek-ai/dsh-client-connection/lib/client.browser.js` from the reviewed rc.2 runtime. The source digest is recorded; the core source digest is recorded separately. Model requests: zero.

[Core behavior and remaining integration](../../../operation-release-core-2026-10-23.md).
