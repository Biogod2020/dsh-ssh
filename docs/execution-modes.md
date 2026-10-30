# Execution ownership and model connectivity

Implemented: the remote DSH daemon owns its Agents, files, terminals and sessions. Local UI, guests and SSH gateways observe and carry requests; closing them does not send a task cancellation. Bootstrap uses a detached process with independent log descriptors. Reconnection restores transport and reads state; it never resubmits prompts, commands or transfers. A remote reboot, process crash, resource limit or administrator logout policy can still end work; this is not a cluster job scheduler or reboot-resumable execution engine.

Independent remote Agents can now receive API-key model configuration through the per-host/per-provider follow policy. Local loopback endpoints and browser sign-in grants are excluded. The local relay and local-Agent modes below remain design options:

| Mode | Model requests | Execution | After this Mac disconnects |
|---|---|---|---|
| Independent remote Agent | Remote-reachable model service | Remote | Can continue model requests and execution |
| Remote Agent with a local model relay | SSH loopback reverse forward to an explicitly chosen local model endpoint | Remote | Already running commands can continue; later model calls lose their route |
| Local Agent, remote executor | This Mac | Remote job runner | Dispatched jobs can continue; no new reasoning/steps from an offline Mac |

Prefer independent remote Agents when uninterrupted operation is required. Where only the Mac has model access, a narrowly scoped SSH reverse forward is simpler than a second command-execution protocol: the remote Agent and its plugins keep their existing semantics. Bind only remote loopback, retain Host-key verification, and forward only the selected model endpoint. API-key synchronization follows the chosen host and provider policy; it does not transfer browser login grants or local-only endpoints. Never expose a public port, forward an unrestricted local proxy, or silently change providers after a failure. OpenSSH documents this direction and loopback behavior in [ssh(1), `-R`](https://man.openbsd.org/ssh.1).

If this Mac must be offline while the remote lacks model access, a third, always-online model endpoint or relay is necessary. Connectivity through the Mac cannot survive that Mac becoming unreachable. A persistent remote job can continue its already-dispatched computation, but an Agent needs a reachable model for its next reasoning step.

A future local-Agent mode should use explicit job identifiers, durable remote receipts, log cursors and separate observe/cancel operations. Ambiguous dispatch must remain unconfirmed; no automatic command replay. It should be a separate task mode because its reasoning lifetime differs from a remote Agent. Do not switch an existing Session's owner implicitly.

On Linux hosts enforcing process cleanup at logout, use an owner-approved service or batch scheduler. A detached process alone does not override that policy. User-service persistence requires host support; see [systemd-run](https://www.freedesktop.org/software/systemd/man/258/systemd-run.html). This release does not enable lingering or modify remote system services.
