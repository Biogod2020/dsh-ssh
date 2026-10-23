# Exact candidate: native draft recovery and Session actions

SHA-256: `a5791380f6b4540800afa9b31984cd3e4a6df429469c276fd25e456f4ab9f148`. Development archive still carries the occupied version jay.39 and must not be published.

- [Native macOS acceptance](native-recovery-final-native.json): manual CUA interactions in a generated isolated Desktop 0.2.1-rc.2 profile, followed by independent compiled-artifact, disk-record and remote PID/birth checks. All three installed JS files in each desktop/web profile match the actual archive; all 100 packaged source files match the tested source.
- [rc.2](native-recovery-final-runtime-rc21.json), [0.2.0-rc.2](native-recovery-final-runtime-rc20.json), [alpha.4](native-recovery-final-runtime-alpha4.json): actual installed-plugin/loopback-SSH baseline acceptance. Each observed 101 catalog reads using one live workspace feed and waited at least the requested 43 seconds. Only rc.2 additionally runs all five Session metadata actions and the generated observation-receipt fixture. Serialized Client checks use a mock Client; they are not native UI checks.
- [Published jay.39 downgrade](native-recovery-final-downgrade.json): actual old-package consumer and the candidate's packaged exporter; 603 retained events, clear fences and original metadata checked.

Full local verification: 97 files / 887 tests, typecheck, build, artifact and portable pure-JS package checks passed. No model requests. No daily profile change. Native latency, automatic operation observation/eviction, memory-budget acceptance and final-candidate 24-hour stability are not established by these reports.

Reproduction uses the repository's `scripts/package-release.mjs`, `scripts/catalog-runtime-smoke.mjs` and `scripts/history-downgrade-smoke.mjs` with absolute CLI/archive paths and new private report paths. Fault injection changes permissions only on the generated local draft directory, then restores 0700; never use it on a user's real profile.

[Behavior, screenshots and provenance correction](../../../native-draft-recovery-2026-10-23.md).
