# Native Session UI and remote shortcut targets

`0.3.24-jay.67` renders the Session components registered by the running DSH. The plugin supplies remote identity and RPC callbacks. Pin, rename, fork, archive/restore, copy-ID, row buttons and rename/active-archive forms keep the official component, ordering, locale and menu lifecycle. SSH-only management is under “Remote host…”.

## Official component boundary

The adapter reads registered entries rather than importing private compiled UI functions or shipping a second DSH interface:

- `sidebar.workspaces.session.menu.item`: `pin`, `rename`, `fork`, `archive`, `session-id`.
- `sidebar.workspaces.session.row.action`: `archive`, `pin`.
- `shell.overlay`: `workspace.session-rename`, `workspace.session-archive`, `workspace.row-toast`.
- `workspace.toast.content`: the official Toast Factory used for remote archive/Undo feedback.

Local occurrences receive their original component and props. Remote callbacks bind a Host, workspace and Session; local business services are not forwarded. Synthetic sidebar keys stay in presentation. Copy-ID receives the real remote ID and uses the official clipboard feedback.

Writes require a ready connection and current catalog. Disconnected menus explain the state and offer a connection-only action, including for archived-only workspaces. It does not open or create a Session. A failed draft save prevents the write and is reported as a draft issue. Delayed errors identify their original target and can be dismissed.

## Archive and navigation

Archive is recoverable, as in local DSH. The official archive filter and restore action expose the remote records. Archiving the selected Session clears only its selected surface, retains the Host client and provides Undo. Undo restores the record; it does not imply that stopped work resumes.

A confirmed `workspace/session-active` refusal carries only bounded, validated activity summaries to the official confirmation form. Cancel sends no second request. Confirm sends one explicit `stopActivity: true` request. Unknown/lost outcomes are never replayed automatically. A successful fork retains the known child if its optional title update fails.

Cold native navigation preserves its original focus instead of focusing the offscreen setup footer. Ordinary click-to-visible movement remains available.

## Temporary shortcut compatibility seam

Official RC2/RC3 do not expose a public target-resolver delegate. The small `shortcut-routing.ts` compatibility layer therefore accesses their private command registry. It requires the reviewed Host release and exact resolver fingerprints before wrapping the four existing command objects: new, rename, fork and archive. It does not edit DSH bundles, registrations, default bindings or user preferences.

Web keyboard dispatch, Desktop keyboard and native menu invocation reach the same resolver. Local input returns the original resolver result with its receiver preserved. Remote modal/offline/identity failures never fall back to a local Session. Targets are captured at resolution and rechecked before action dispatch; repeats do not run another action.

Installation is atomic with rollback. Disposal restores only identities still owned by this layer; a captured inner wrapper becomes inert under another owner's wrapper. Public catalog changes invalidate the layer if commands are replaced. The embedded guest is hidden without discarding its draft, remote selection is cleared and further embedded opening is disabled. Unknown implementations use standalone Web navigation or an explicit unavailable result in Desktop. Normal Cordis registration/unregistration is covered; unrelated direct private-registry mutations without catalog notification are outside this compatibility contract.

This seam is separate from the official component adapter. A future public delegate can replace it without rebuilding the menus/forms. New DSH resolver implementations require review before enabling embedded shortcuts.

## Verification

The release gate includes full tests, typecheck, build, archive checks and installation in all four declared DSH runtimes. Contract tests execute the installed SDK registry and Desktop native keyboard/menu bridge. Generated loopback SSH/browser acceptance covers the four parent-window shortcuts, native menus, copy, archive/restore and local draft preservation, without a model request or production-account mutation. Web acceptance is not described as a new native Desktop GUI test.

The offline downgrade fixture extracts the shared `src/private-mode.ts` helper beside its history sources. That file was already present in the unpublished jay.66 archive; the fixture's selective extraction list omitted it and stopped that tag before publication. jay.67 corrects the fixture and explicitly checks the archived helper while retaining all permission and data-preservation assertions.
