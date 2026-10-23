# Remote clipboard and native Session actions — candidate verification

This is an unpublished development candidate for Desktop 0.2.1-rc.2. The daily installation remains unchanged.

## Behavior

Remote Session rows now use the existing native ellipsis menu and row-action seat for archive and pin buttons, with rename, unarchive and unpin in the same menu. Native pinned ordering and archived filters consume remote Host metadata. The local Host never receives the projected remote Session ids.

Each metadata action checks the saved Host identity and current remote Workspace membership, then sends one authenticated official RPC. Lost acknowledgements trigger a read, never a repeated write. An active-session archive refusal may be followed by an explicitly confirmed stop request; an unknown transport outcome never offers that retry. Archiving the displayed Session first confirms its text draft save. Pin/archive recovery metadata is persisted with the existing navigation cache.

After a remote shell clears its selection on archive, reopening the same Session now consults the actual remote selection. An already-current selection cancels older pending choices and returns immediately without a draft load or network request.

## Clipboard diagnosis and fix

The shipped Desktop browser guest denies all permission requests/checks (`DesktopBrowserGuests.configureSession`). The remote copy helper calls `navigator.clipboard.writeText`; its existing fallback is used only when that API is absent, not when permission is denied.

The authenticated embedded page installs a page-local compatibility wrapper before Client boot. A focused, visible document with a current user gesture can perform a synchronous text copy. The wrapper restores the input caret or DOM selection, including backward selections. Failure falls through to the original API and remains a rejection. Ordinary web pages and the local Client are unchanged. There are no clipboard reads, permission changes, private IPC, HTTP transfers or SSH operations in this path. The legacy copy command is a compatibility path for this Desktop policy, not a claim of support for every browser.

## Verified evidence

- Full verification: **93 files / 846 tests**, typecheck, build, artifact checks and pure-JS archive checks passed. All 98 packed source files match this source snapshot.
- The same archive passed isolated DSH/loopback SSH catalog, carrier and serialized-Client checks on **0.2.1-rc.2, 0.2.0-rc.2 and 0.2.1-alpha.4**. On rc.2 it also performed all five metadata actions through the installed plugin route. The new actions are not counted as verified on the other two versions.
- The packaged offline exporter and actual published jay.39 consumer passed the retained-history downgrade check.
- Real macOS isolated Desktop: message copy followed by paste returned the generated message; native remote row buttons appeared; pin reordered the row; rename changed the title; archive removed it from the default filter; native archived filtering exposed its unarchive button. This used the native app and generated data, with no model requests.
- Actual Gemini reviews: `IsfaasSnL9SMytMPxbHz0QQ`, `iczaaqORAZOciLMP0ZnWuQY`, `Z9DaapmuGoaiuMYPtYmy2AQ`; requested gemini-3.8-flash-high, returned gemini-3.8-flash-n. Findings were checked against shipped SDK code and regression tests.

[Runtime, downgrade and provenance reports](benchmarks/2026-10-22/clipboard-session-actions/README.md). Candidate SHA-256: `cfb94218df54f9be8d527ca68102cb25abab90e9dc51fed10416d6675a2cff68`.

## Remaining acceptance

Native code-block copy and final archive/unarchive/reopen with valid generated history are still pending. Earlier handwritten fixture messages omitted assistant stream metadata and triggered projection failures; these test records are preserved privately and are not counted as successful history acceptance. A corrected test generator is prepared. The Mac locked before that final native run. The native latency matrix, focus/menu/sleep acceptance, a stable final-candidate 24-hour run and memory-release policy also remain open under the existing iteration goal.

The corrected generator has now been exercised in an actual isolated **web Client** using the installed `a9f82b7…c58ff3` candidate. Its six events render successfully, and code-block plus whole-reply copy/paste preserve Chinese, emoji and Markdown. The empty test draft was confirmed on disk afterward. [Screenshot and exact results](benchmarks/2026-10-22/web-clipboard/README.md). This narrows the remaining fixture uncertainty; it does not replace native guest/focus acceptance.

One earlier package attempt had two 5-second test timeouts. The unchanged focused checks then passed, and the complete final package verification passed; thresholds were not increased. No npm tag, release, or daily-app update was performed.
