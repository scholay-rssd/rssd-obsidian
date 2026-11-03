# RSSD for Obsidian (stage 1)

Open one RSSD Center space as a vault of drafts, see each work's sync state, and save edits back as **private drafts**. Nothing here publishes.

## Use

1. Create an empty vault **outside the git repo**, one vault per space (a space is a site).
2. Build and install:
   ```sh
   cd obsidian
   npm install
   npm run build
   node install.mjs /path/to/vault
   ```
3. In Obsidian enable the plugin, open Settings → RSSD, enter the Center address and run **Log in to the RSSD Center**. Approve the device and its spaces in your browser.
4. Run **Pull works from the Center**. Chinese works appear in `Works/<id>.md`, English works in `Works/en/<id>.md`, and images in `article-media/`.
5. Automatic sync is on by default. While Obsidian and the vault are open, it checks for remote changes periodically and saves edits to linked works as private drafts after a short delay. It discovers offline edits after reopening. Use Settings → RSSD → **Automatic sync** to turn it off. The manual pull and save commands remain available.
6. Active spaces save to Center private drafts. When the Center advertises staged-draft support, a staged space saves an independent private migration draft based on its imported snapshot; the original site still owns publication, and later legacy changes can require reconciliation. Neither kind of save publishes. Mobile is read-only.

Commands: *Log in*, *Pull works*, *Save this work*, *Check sync state of all works*.

## Rules (from the RSSD business spec)

- The Center is the source of truth. Do not run Obsidian Sync, iCloud or Git on this vault.
- A note is identified by its `rssd-id` property, never by its file name. Do not edit `rssd-*` properties.
- A pull never overwrites a note with local changes; a conflict is reported and the note is left as written.
- The Center sends bounded batches when supported; the plugin falls back to limited individual reads. Interrupted pulls retain completed work and report failures for retry.
- A save carries the exact base version and is refused if the Center moved. The Center must explicitly confirm it preserves existing attachments and editorial metadata. It never publishes.
- A save whose answer was lost keeps its request key and is recovered by that key, never resent.
- Structured records (`year`, `history`, `openSource`) require a Center that explicitly supports safe private drafts. Only the title and the prose inside their existing named sections are editable; the first Markdown H1 must match the title. Other properties, section names and source fields must remain unchanged. Invalid edits stay local and are reported.
- Referenced images are detected by their bytes and uploaded by content hash. Supported syntax is a relative Markdown path under `article-media/` or an explicit `![[article-media/name.png|alt]]` embed. Ambiguous `![[image.png]]`, files in other directories and unreferenced hidden-attachment replacement cannot be safely synchronized. A work may reference at most 12 PNG, JPEG or WebP images totaling 2 MiB.
- New unlinked notes, local renames and local deletions do not create, rename or delete Center works. Moved or missing linked notes are reported and are not silently recreated. Return the original note to its linked path to resume syncing.

## Interrupted pulls and saves

- A pull can take time, especially when articles include images. A batch can wait up to 300 seconds for the same request; after that the current pull stops rather than duplicating a request that Obsidian cannot cancel. Wait for the connection to recover before running **Pull works from the Center** again. Already confirmed articles and their baselines are retained; the next pull checks them and resumes the remaining work.
- A finished pull can still report skipped local edits, conflicts, unresolved saves or failures. Skipped local edits are preserved; conflicts need review before another save. The latest operation's private `.obsidian/plugins/rssd/last-run.json` includes its state, progress and any recorded errors. Keep this file and the plugin's settings private.
- If the answer to a save is lost, leave the note and plugin settings in place. Run the save command again on that note: the plugin checks the original request's Center receipt instead of submitting a second draft. An unresolved receipt is not proof that the save failed or succeeded.
- If a save succeeds but warns that its local version label could not be refreshed, the Center draft was saved. A later pull attempts a safe refresh of the `rssd-version` label while preserving note edits; do not send another save merely to repair the label. If the warning persists, inspect the note's identity properties and local changes.

## Not yet

Publishing, live production logs, the chat sidebar, merge view, logged-in source pages, and renaming or deleting works from the vault.

## Develop

`npm test` runs the sync rules against an in-memory vault and a stub Center (no Obsidian needed). The pure rules live in `src/sync-model.mjs`, `src/sync-engine.mjs`, `src/center-client.mjs` and `src/device-login.mjs`; `src/main.js` is the only file that touches Obsidian. Sync-state logic is shared with the rest of RSSD through `contracts/sync-state.mjs`.

## Works panel and command links

Run **Open RSSD works** (or use the ribbon icon) to see readable titles and current sync states. Space selection lists authorized spaces; after downloading works the vault is bound to that space. A staged private draft is a separate migration branch and does not activate its site. Mobile cannot save private drafts.

Command links are off by default and can be enabled in RSSD settings for an operator-controlled vault. Example:

```
obsidian://rssd?vault=metho&do=status&requestId=status-001
```

Supported actions: `login`, `pull`, `status`, `spaces`, `save`. Save also requires an exact `path=Works/<id>.md` or `path=Works/en/<id>.md` (URL-encode the path). Each accepted command writes `.obsidian/plugins/rssd/runs/<requestId>.json`; `last-run.json` is a convenience copy. Reusing an ID returns the previous record, including an interrupted `running` record; it never repeats the action. Use a new command ID for an intentional retry. A pending draft save is still reconciled by its original **Center** request key. Keep these receipts private; no token is written into them.

Buttons, commands, panel refresh and command links share one operation gate. A busy vault refuses another operation rather than queuing a potentially stale save. Failed login preserves the server error and closes its modal; an old token does not turn that failure into a success.

See [product scope and remaining work](../docs/obsidian-product.md).
