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
5. Edit a note, then run **Save this work to the Center as a private draft**.

Commands: *Log in*, *Pull works*, *Save this work*, *Check sync state of all works*.

## Rules (from the RSSD business spec)

- The Center is the source of truth. Do not run Obsidian Sync, iCloud or Git on this vault.
- A note is identified by its `rssd-id` property, never by its file name. Do not edit `rssd-*` properties.
- A pull never overwrites a note with local changes; a conflict is reported and the note is left as written.
- The Center sends bounded batches when supported; the plugin falls back to limited individual reads. Interrupted pulls retain completed work and report failures for retry.
- A save carries the exact base version and is refused if the Center moved. The Center must explicitly confirm it preserves existing attachments and editorial metadata. It never publishes.
- A save whose answer was lost keeps its request key and is recovered by that key, never resent.
- Structured records (notices, history, resources) download read-only.

## Not yet

Publishing, live production logs, the chat sidebar, merge view, logged-in source pages, and renaming or deleting works from the vault.

## Develop

`npm test` runs the sync rules against an in-memory vault and a stub Center (no Obsidian needed). The pure rules live in `src/sync-model.mjs`, `src/sync-engine.mjs`, `src/center-client.mjs` and `src/device-login.mjs`; `src/main.js` is the only file that touches Obsidian. Sync-state logic is shared with the rest of RSSD through `contracts/sync-state.mjs`.

## Works panel and command links

Run **Open RSSD works** (or use the ribbon icon) to see readable titles and current sync states. Space selection lists authorized spaces; after downloading works the vault is bound to that space. A staged space remains readable but cannot save. Mobile cannot save private drafts.

Command links are off by default and can be enabled in RSSD settings for an operator-controlled vault. Example:

```
obsidian://rssd?vault=metho&do=status&requestId=status-001
```

Supported actions: `login`, `pull`, `status`, `spaces`, `save`. Save also requires an exact `path=Works/<id>.md` or `path=Works/en/<id>.md` (URL-encode the path). Each accepted command writes `.obsidian/plugins/rssd/runs/<requestId>.json`; `last-run.json` is a convenience copy. Reusing an ID returns the previous record, including an interrupted `running` record; it never repeats the action. Use a new command ID for an intentional retry. A pending draft save is still reconciled by its original **Center** request key. Keep these receipts private; no token is written into them.

Buttons, commands, panel refresh and command links share one operation gate. A busy vault refuses another operation rather than queuing a potentially stale save. Failed login preserves the server error and closes its modal; an old token does not turn that failure into a success.

See [product scope and remaining work](../docs/obsidian-product.md).
