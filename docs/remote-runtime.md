# Remote DSH workspaces

## Ownership and reference

The local DSH owns SSH host configuration, the workspace catalog, setup operations and authenticated browser gateways. Each remote account owns a complete DSH process, its plugin runtime, filesystem, terminals, sessions and model configuration. The browser loads the remote service's own frontend and plugin manifest through a separate local origin; changing hosts reloads that host's client composition. No SDK mutation or DSH monorepo patch is required.

The architecture reference is upstream `openai/codex`, commit `4b1c0c30dabd08fed7d6523844f9156d982eb297`. Inspected modules:

- [app-server-client README](https://github.com/openai/codex/blob/4b1c0c30dabd08fed7d6523844f9156d982eb297/codex-rs/app-server-client/README.md): shared client lifecycle and transport semantics.
- [remote client transport](https://github.com/openai/codex/blob/4b1c0c30dabd08fed7d6523844f9156d982eb297/codex-rs/app-server-client/src/remote.rs): initialization identity, authenticated transport, request/response and event ownership.
- [official SSH workflow](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host): the desktop starts a remote app-server through SSH.

These informed the process/transport boundary. This implementation speaks DSH's existing protocol and does not depend on Codex Rust code or Codex models. The preflight and installer are maintained in this repository.

## Setup lifecycle

1. Validate the selected configured host and every jump/target key through the existing SSH engine.
2. Stream `assets/remote-install.sh` over one SSH exec channel. Detect OS, architecture and a working compatible Node, then locate an exact DSH release. Only missing components need download prerequisites and disk checks.
3. Download fixed official Node artifacts with pinned SHA-256 values. Verify the DSH root tarball against its pinned SHA-512 before npm resolves dependencies. npm records dependency integrity in the release lockfile. Dependency resolution on the first installation still follows the package's dependency ranges.
4. Stage in a private directory; check executable Node and DSH CLI/web support before activation. A per-account install lock prevents concurrent installers. Failures preserve staging logs without replacing working installations.
5. Run `assets/remote-bootstrap.mjs` with an independent DSH data directory. Publish the spawned PID before waiting for the authenticated launch URL. Reuse an authenticated live receipt; recover a partially published receipt from the private log; never replace an unresponsive but live process.
6. Establish an SSH port forward and authenticate DSH through that HTTP authority. Create the workspace through `workspace/create`, persist its Host + canonical path identity locally, and open/create its remote session.
7. Exchange a short-lived, single-use local launch ticket for an HttpOnly gateway cookie, redirect to a clean URL, and load the complete remote frontend. The upstream DSH token/cookie never reaches browser HTML or the workspace catalog.

Node pins were checked against official release checksums on 2026-09-25. The reviewed DSH pin is `0.2.1-alpha.4` (official npm metadata checked 2026-10-15); its version, integrity and exact compatible releases live in `src/remote/types.ts` and are passed explicitly to the installer/bootstrap. The installer reports the actual chosen version and reuses tested `0.1.6-alpha.2` / `0.1.7-alpha.1` / `0.2.0-rc.2` installations. A compatible live daemon is not restarted to follow the new pin. Node platform prerequisites follow the [Node 22 to 24 migration documentation](https://nodejs.org/en/blog/migrations/v22-to-v24).

## Runtime and reconnect

The gateway forwards generic HTTP, file responses and WebSocket streams, retaining backpressure. It authenticates requests and checks their origin before forwarding. Requests use only the selected DSH endpoint; browser cookies/authorization from other local origins are not sent upstream. HTML receives an explicit Host bar and initial remote-session selection.

A connection repair reconnects only the SSH tunnel and authentication handshake. It preserves the gateway port, browser storage and remote process. It never retries a request body or a user command. The DSH frontend owns stream resubscription and state reconciliation. Stopping the local controller closes its gateways and tunnels, while remote DSH remains alive.

Workspace tunnels are private to the runtime manager. User `ssh_tunnel` listing/stop/stop-all cannot enumerate or stop them. Explicit host removal, manager teardown and engine disposal still release owned resources. Stopping a user's last forward does not drop a pooled connection while an unrelated command is in flight.

## DSH client compatibility

DSH 0.2 native navigation uses `sidebar.panellist` and the keyed `main` slot when `layout.selectPanel` and `layout.panelInfo` are available. The main occupant is a seat for a separately retained React root: deselection parks its DOM in a fragment instead of unmounting terminals, queues, running cluster observers or unsent drafts. Disposal releases that root. Legacy shells retain the existing DOM mount. The package declares the exact reviewed versions at top-level `engines.dsh` for alpha.4's compatibility preflight and keeps the historical nested declaration in agreement.

The 0.2 frontend uses `configForms` and volatile configuration references. The plugin accepts the live/native setting service when present and falls back to the old settings binder; it never requires both. Settings changes update announcement/font behavior without destroying an active SSH engine. Disabling the plugin explicitly tears down its gateways/routes.

Native panels may now declare owned child slots. The legacy-workspace guard projects a native entry and mirrors its children under private names using public `entries`, `subscribe` and `register` APIs. It neither redeclares native ownership nor mutates the official registry. The guarded legacy Files view remains a migration notice, and its Terminal stays locked to the saved SSH identity.

After a local DSH restart, an old gateway port and its browser cookie cannot be reused. The old page detects repeated status failures and offers a recovery link that opens a new tab, preserving unsent text in the old one. Its fragment carries the selected remote session and a Host-scoped HMAC proof; the proof key is a private local file and survives controller restart. The authenticated local client submits the proof, reconnects the saved Host through the normal installer/bootstrap path, and launches the selected remote session on a fresh gateway origin. An invalid proof fails before SSH setup. The link is removed from the new tab's address before connection. If local DSH is not running or its login expired, the user must start/sign in to local DSH and reopen the recovery link. No in-flight request, command, transfer, plugin action or agent prompt is replayed.

## Migration and limits

- New entries have `hostId`, `remotePath` and the remote `workspaceId`; they have no `localPath`. Changing a host's address/account changes its identity and cannot silently retarget an old workspace.
- Old local workspace conversations remain locally readable. Their tools are blocked; their remote paths appear in the new catalog for explicit connection. History and model credentials are not imported.
- The initial remote profile is independent. Configure a model and install remote plugins through its native UI. A local-only model endpoint requires a separately configured route reachable from the remote host.
- Plugin backends using `node:fs` now run beside their files. Plugins using desktop-native dialogs, platform-specific renderers or special browser cookie/auth flows may still need adaptation. Runtime installation does not promise arbitrary plugin compatibility.
- Host switching uses complete client compositions, with a return/switch link. This is not a cross-host merged session archive or simultaneous multi-host client context.
- Install and startup locks fail closed on an unverified/interrupted owner. No automatic lock deletion, sudo, shell-profile edits, global upgrades, or unrelated-service restarts are performed.

## Verification

`pnpm test`, `pnpm typecheck`, `pnpm build`, `node scripts/check-artifact.mjs`, and the isolated runtime/browser smoke are required before deployment. The real-SSH runtime test covers a plugin's direct filesystem operation, native terminal allocation, event WebSocket delivery, ticket/authentication fences and reconnection without daemon restart. `scripts/remote-browser-smoke.ts` creates isolated local/remote homes and confirms the SSH HOME boundary before exposing its browser entry.

Repeatable commands (all fixtures are disposable private homes; never target the daily host store):

```sh
node scripts/compatibility-smoke.mjs /absolute/path/to/reviewed/dsh
DSH_REMOTE_TEST_DSH=/absolute/path/to/reviewed/dsh pnpm exec vitest run tests/remote-runtime.test.ts
DSH_SMOKE_DSH=/absolute/path/to/reviewed/dsh node --experimental-transform-types scripts/remote-browser-smoke.ts
# While that fixture is running, after configuring the two fixture aliases through its GUI:
node --experimental-transform-types scripts/agent-tools-smoke.ts /printed/dsh-remote-browser-root
```

The runtime test uses the supplied CLI instead of downloading a release during every test run. Installer unit tests retain version/integrity rejection coverage; cold installation is separately exercised by the browser fixture. Tool smoke runs the six actual tool implementations through a real SSH engine without calling a model. It validates the fixture root/HOME boundary before writing, and keeps logs/results private. See [verification.md](verification.md) for observed results and incomplete browser-save coverage.


## Desktop presentation (jay.29)

Desktop launches use the shipped `dshDesktop.browser` guest interface. A workspace-scoped lease and isolated storage partition are acquired before attaching a `webview` at `about:blank#<lease>`. Only after the Desktop shell authenticates that guest does the plugin load the loopback gateway's single-use ticket. The gateway, HttpOnly/SameSite cookie and every SSH host-key check are unchanged; the guest has no Node, preload or local Host bridge. The main window stays on `dsh-app://app/` and does not navigate out to the system browser.

A parent toolbar returns to local UI without detaching the remote client. Reopening the same Host/workspace keeps that client and its unsent draft instead of reloading it. Up to eight views are retained. Explicitly closing a view confirms draft loss, releases only its guest lease, and leaves the remote service running. Host or explicitly selected-session changes cannot silently retarget an already-open view. Aborting a pending view releases its lease; cancelling the completed workspace observer does not close an opened view. Failed loads never print ticket-bearing URLs or retry submitted remote work.

The desktop's standard guest policy blocks page downloads and native privileges. Local SSH transfer tools remain available after returning to local. This presentation does not merge local model settings or local/remote session archives. Browser deployments retain top-level in-tab navigation; a Desktop shell without the guest API reports an update requirement instead of automatically opening a browser.
