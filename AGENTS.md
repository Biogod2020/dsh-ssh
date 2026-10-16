# DSH SSH Ops working agreements

- Maintain this standalone module; no upstream monorepo is required.
- Verify every target and jump host against known_hosts; fail closed.
- Never replay commands or transfers after dispatch. Preserve uncertain outcomes.
- No telemetry. Preserve user sessions, credentials and model configuration.
- Maintain copied shared sources here; do not run upstream synchronization scripts.
- Before deployment run `pnpm test`, `pnpm typecheck`, `pnpm build`, artifact checks and isolated runtime acceptance.
- Test only in private disposable homes with generated SSH identities unless the user explicitly authorizes a real host.
- Preserve existing working-tree changes and never put credentials or access-bearing URLs into Git or shared logs.
- Do not publish to npm. Git pushes and GitHub releases require user authorization.
- Release packages include the required pure-JS SSH dependency closure. Keep archive paths inside `package/` and exclude optional native binaries.
