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
4. Run **Pull works from the Center**. Works appear in `Works/<id>.md`, images in `article-media/`.
5. Edit a note, then run **Save this work to the Center as a private draft**.

Commands: *Log in*, *Pull works*, *Save this work*, *Check sync state of all works*.

## Rules (from the RSSD business spec)

- The Center is the source of truth. Do not run Obsidian Sync, iCloud or Git on this vault.
- A note is identified by its `rssd-id` property, never by its file name. Do not edit `rssd-*` properties.
- A pull never overwrites a note with local changes; a conflict is reported and the note is left as written.
- A save carries the exact base version and is refused if the Center moved. It never publishes.
- A save whose answer was lost keeps its request key and is recovered by that key, never resent.
- Structured records (notices, history, resources) download read-only.

## Not yet

Publishing, live production logs, the chat sidebar, merge view, logged-in source pages, and renaming or deleting works from the vault.

## Develop

`npm test` runs the sync rules against an in-memory vault and a stub Center (no Obsidian needed). The pure rules live in `src/sync-model.mjs`, `src/sync-engine.mjs`, `src/center-client.mjs` and `src/device-login.mjs`; `src/main.js` is the only file that touches Obsidian. Sync-state logic is shared with the rest of RSSD through `contracts/sync-state.mjs`.
