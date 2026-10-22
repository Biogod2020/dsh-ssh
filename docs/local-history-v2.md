# Local history v2 (development candidate)

This describes the candidate on `codex/ssh-native-iterations`. The installed npm release remains `.39` until release acceptance is complete.

Remote conversations stay on their remote Host. Once a conversation has been opened, its committed events are also saved in a private directory on this computer. Reopening a saved conversation reads a bounded local window; synchronization asks for events after its saved cursor. Unchanged history sends no event records and rewrites no event segment. This does not eliminate the embedded DSH client's own startup and live-view requests.

Copies have no expiry or automatic deletion. The cache manager lets you filter by Host/project and clear selected conversations. It reminds you at 512 MiB, 100 conversations, or 30 days of retention; “Remind in 7 days” postpones the reminder without deleting data. Clearing a local copy does not delete the remote conversation or stop its tasks. A durable per-conversation barrier rejects reads started before clearing, including after an explicit reopen.

The candidate stores immutable event segments, an append-only descriptor index, and a small atomic root manifest. A committed root names the exact verified index prefix. A process killed while writing can leave unreferenced files; those are not treated as confirmed history. The reported copy size includes committed segments, descriptors, the root, and its retained v1 migration archive. It does not currently account for all abandoned transaction files.

The reader shows up to 200 events per local window and about 2 MiB of message bodies. Earlier history is fetched from disk as needed. Large single events show a placeholder with an explicit download for the original record; they are not cut out of the stored conversation. A single event above the supported 64 MiB segment limit stops synchronization and preserves the existing copy.

## Migrating and returning to an older plugin

Do not run old and new plugin writers against the same DSH Home. The old writer does not understand the v2 lock.

Migration happens when a saved conversation is synchronized, rather than converting the entire collection at startup. The original v1 file stays active until a validated v2 root is committed. It then moves into the conversation's managed migration archive, outside the old scanner. The archive preserves the original history and first-saved time. Older releases cannot read new v2 increments directly.

To prepare a downgrade:

1. Fully exit the DSH processes that write this history directory. Leave remote tasks running; the export tool does not connect to remote Hosts.
2. Locate the plugin's local history directory. Use explicit paths; the tool does not search your Home or read SSH/model configuration.
3. From this source checkout, run the command below. The export destination must be new.

```sh
node --experimental-transform-types scripts/export-history-v1.mjs \
  /absolute/path/to/history /absolute/path/to/new-v1-export
```

The same script is included in the candidate npm package under `scripts/export-history-v1.mjs`. It requires Node 22.19+ or 24+ and the package's shipped `src` directory.

The tool exports from current committed copies and clear barriers, then reopens the output with the old reader and compares event hashes, cursors and first-saved times. Successful output contains `verified: true`. It does not automatically restore the export or copy credentials. Do not substitute the retained migration archives for this export: they can be older than the latest saved history and can include data a user subsequently cleared.

Before starting the old plugin, retain a private backup of the current history directory, then explicitly select the verified v1 export as its replacement. Keep all other profile settings, models, plugins and sessions intact. This final profile change is intentionally outside the export tool.

## Verification boundary

The implementation has POSIX permission, fsync, lock, process-death, migration, clear-race and real SSH tests. Native macOS interface acceptance and the final release candidate are separate gates. Windows ACL, occupied-file replacement and power-loss semantics require platform-specific acceptance before the same durability claim can be made there.
