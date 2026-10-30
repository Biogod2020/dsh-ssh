# Reusing official Session UI for remote Hosts

The `.64-local.1` candidate renders the Session action components registered by the running DSH. The plugin supplies remote identity and RPC callbacks. Pin, rename, fork, archive/restore, copy-ID, row buttons, and rename/active-archive forms keep the official component, ordering, locale and menu lifecycle. This replaces the separately maintained remote menu and rename form.

## Extension boundary

`native-session-adapter.tsx` binds each action to a frozen Host, remote workspace and Session. `slot-projection.tsx` preserves official child slots and their metadata. Local occurrences receive their original component and props. Remote occurrences receive a narrow, Host-bound callback share; local business services are never forwarded. Synthetic sidebar keys stay in the presentation layer. Copy-ID receives the real remote Session ID and uses the official clipboard/toast callback.

The adapter reads these registered slots, without importing private compiled functions or shipping another copy of DSH UI:

- `sidebar.workspaces.session.menu.item`: `pin`, `rename`, `fork`, `archive`, `session-id`.
- `sidebar.workspaces.session.row.action`: `archive`, `pin`.
- `shell.overlay`: `workspace.session-rename`, `workspace.session-archive`.

SSH-only management lives under “Remote host…”. Missing official forms or unknown new action IDs are not guessed. Writes require a current catalog and a ready connection. A future DSH release can replace its registered components automatically while preserving these contracts; changed contracts still require compatibility checks.

## Archive and failure behavior

Archive means recoverable archive, as in local DSH. The official archived filter and restore action expose the same remote records. Archiving the selected Session hides only its selected surface, without a second close prompt or releasing the retained Host client. Navigation to a newer selection is preserved.

The initial archive request never stops work implicitly. A confirmed `workspace/session-active` rejection may carry a bounded, validated activity summary to the official confirmation form. Cancel sends no second request. Confirm sends one explicit `stopActivity: true` request. Unknown/lost outcomes never cause an automatic replay. Fork retains a known created child when the optional title update fails.

## Shortcut boundary

The RC2/RC3 parent-window global workspace shortcuts still resolve against the local Host. Reusing menu components alone does not make those global commands remote-aware. The adapter hides their misleading shortcut hints; it does not modify the global shortcut registry, local Controller or user bindings. The remote client handles shortcuts within its own frame.

A separate upstream proposal adds one synchronous `workspace/resolve-shortcut` event at the official shared resolver. An external Host adapter can then return handled/blocked or defer to the existing local resolver. This proposal is not applied to installed DSH. Until that interface is available, use the remote menu for parent-sidebar Session actions; full global shortcut parity is not claimed.

## Verification and installation status

The exact `.64-local.1` archive passed 126 files / 1,141 tests, type checking, build and artifact checks. Isolated installation smoke passed DSH `0.2.1-rc.2` and `0.2.1-rc.3`. Actual Codex built-in browser acceptance used a generated loopback SSH account and real remote DSH: cold opening, native rename, archive, archived filtering, restore through both menu and row, warm reopening, and real remote ID copy. No real model request or production account mutation was used. Native active-archive cancel/confirm is covered by focused component/protocol tests, not by stopping a user's running task.

The first-connection sidebar jump was separately reproduced in `.59`: progress UI focused the footer's “Continue in background” button when a native row left focus on `body`. The fix preserves native navigation focus and uses `preventScroll` for the fallback path. Browser acceptance no longer reaches the list's bottom; ordinary click-to-visible movement may still occur.

This candidate is staged, not installed in the daily Web/Desktop profiles. The source documentation was added after the executable archive was verified; the runtime source is unchanged. Daily services, credentials and running tasks were preserved.

## Follow-up UX review

The `.65-local.1` candidate adds a connection-only menu entry with an explanation while remote writes are unavailable. It reuses the existing SSH progress flow and does not open or create a Session; an archived-only workspace can reconnect before restoring a record. A failed draft save is reported as a draft problem before any remote write. Late action errors identify their original Host and Session and can be dismissed.

Successful archive now uses the registered official `workspace.toast.content` Factory and its locale/timing, with an Undo action bound to the original remote Host. It restores the record without implying that previously stopped work will resume. An existing local toast is replaced on arrival; a newer local toast takes priority. The local Session components and callbacks remain unmodified.

The shortcut limitation above remains a release concern: the parent-window native resolver can act on a parked local Session while the remote main panel is selected. Hiding hints does not prevent that action. The candidate should not be presented as complete native parity or silently deployed until this routing boundary has a supported solution.

## jay.66 release resolution

The remaining parent-window shortcut issue is addressed by `shortcut-routing.ts`. Official RC2/RC3 lack a public resolver delegate, so this release explicitly uses one temporary private registry seam. It verifies the Host release and the exact four resolver function fingerprints before any assignment, preserves command objects and all binding/preferences metadata, and routes both native menu invocation and keyboard dispatch through the same target decision. Local decisions call the original resolver with its original receiver. Remote failures never fall back to local commands.

Installation is atomic with rollback. Unload restores only command/resolver identities still owned by this layer; an outer wrapper keeps its own ownership and any captured inner wrapper becomes inert. The public catalog subscription invalidates the layer when command identities change. The retained guest is hidden without discarding its draft, remote selection is cleared, and new embedded navigation is disabled. Unknown implementations use standalone Web navigation, or an explicit unavailable result in Desktop. Normal Cordis command registration/unregistration is covered; unrelated plugins directly mutating private internals without publishing catalog changes are outside this compatibility contract.

The previous .64/.65 shortcut release concern above is historical context. This release does not require installing the separate upstream proposal or editing DSH bundles. The source-level/registry tests use the actual installed SDK and cover Web dispatch, Desktop keyboard and native menu bridge, modal/offline input, repeats, target changes, partial rollback and ownership-preserving removal. The four runtime installation matrix remains the release gate; embedded shortcut support is limited to the two reviewed RCs.
