# RSSD for Obsidian (stage 1)

This repository is checked out at `obsidian/` inside an
[RSSD](https://github.com/scholay-rssd/rssd) checkout and imports its shared
`contracts/`. Run the commands below from that directory.

## Read articles online (no download)

Install the plugin into any vault and open it. A welcome window offers **Log in to RSSD**: the browser opens, you sign in and approve the device, and the **RSSD reader** tab opens with the site's published articles. Click an article to read it rendered, with its images; nothing is written into the vault. Switch site (when the device is approved for several), language and *Include unpublished drafts* at the top. Reopen it later from the book ribbon icon or the *Read site articles online* command.

The Center address defaults to `https://post.linkc.cloud`; build with `RSSD_DEFAULT_ORIGIN=https://… npm run build` for another Center. A login from the welcome window does not choose a sync space, so automatic sync stays off until someone picks a **Sync space** in Settings for editing.

## Edit as drafts

Open one RSSD Center space as a vault of drafts, see each work's sync state, and save edits back as **private drafts**. Nothing here publishes.

## Use

1. Create an empty vault **outside the git repo**, one vault per space (a space is a site).
2. Build and install:
   ```sh
   npm install
   npm run build
   node install.mjs /path/to/vault
   ```
3. In Obsidian enable the plugin, open Settings → RSSD, enter the Center address and run **Log in to the RSSD Center**. Approve the device and its spaces in your browser.
4. Run **Update works from the Center**. Chinese works appear in `Works/<id>.md`, English works in `Works/en/<id>.md`, and images in `article-media/`.
5. Automatic sync is on by default. While Obsidian and the vault are open, it checks for remote changes periodically and saves edits to linked works as private drafts after a short delay. It discovers offline edits after reopening. Use Settings → RSSD → **Automatic sync** to turn it off. The manual update and save commands remain available.
6. Active spaces save to Center private drafts. When the Center advertises staged-draft support, a staged space saves an independent private migration draft based on its imported snapshot; the original site still owns publication, and later legacy changes can require reconciliation. Neither kind of save publishes. Mobile is read-only.

Commands: *Log in*, *Update works*, *Save this work*, *Check sync state of all works*.

**Update** brings the Center's latest versions down into the vault, and **Save** sends edits up as private drafts. Internally an update is still a *pull*: the command id and the `pull` action for command links are unchanged, so existing hotkeys and links keep working.

## Rules (from the RSSD business spec)

- The Center is the source of truth. Do not run Obsidian Sync, iCloud or Git on this vault.
- A note is identified by its `rssd-id` property, never by its file name. Do not edit `rssd-*` properties.
- An update never overwrites a note with local changes; a conflict is reported and the note is left as written.
- The Center sends bounded batches when supported; the plugin falls back to limited individual reads. Interrupted updates retain completed work and report failures for retry.
- A save carries the exact base version and is refused if the Center moved. The Center must explicitly confirm it preserves existing attachments and editorial metadata. It never publishes.
- A save whose answer was lost keeps its request key and is recovered by that key, never resent.
- Structured records (`year`, `history`, `openSource`) require a Center that explicitly supports safe private drafts. Only the title and the prose inside their existing named sections are editable; the first Markdown H1 must match the title. Other properties, section names and source fields must remain unchanged. Invalid edits stay local and are reported.
- Referenced images are detected by their bytes and uploaded by content hash. Supported syntax is a relative Markdown path under `article-media/` or an explicit `![[article-media/name.png|alt]]` embed. Ambiguous `![[image.png]]`, files in other directories and unreferenced hidden-attachment replacement cannot be safely synchronized. A work may reference at most 12 PNG, JPEG or WebP images totaling 2 MiB.
- New unlinked notes, local renames and local deletions do not create, rename or delete Center works. Moved or missing linked notes are reported and are not silently recreated. Return the original note to its linked path to resume syncing.

## Interrupted updates and saves

- An update can take time, especially when articles include images. A batch can wait up to 300 seconds for the same request; after that the current update stops rather than duplicating a request that Obsidian cannot cancel. Wait for the connection to recover before running **Update works from the Center** again. Already confirmed articles and their baselines are retained; the next update checks them and resumes the remaining work.
- A finished update can still report skipped local edits, conflicts, unresolved saves or failures. Skipped local edits are preserved; conflicts need review before another save. The latest operation's private `.obsidian/plugins/rssd/last-run.json` includes its state, progress and any recorded errors. Keep this file and the plugin's settings private.
- If the answer to a save is lost, leave the note and plugin settings in place. Run the save command again on that note: the plugin checks the original request's Center receipt instead of submitting a second draft. An unresolved receipt is not proof that the save failed or succeeded.
- Sync records are kept in the plugin settings (`data.json`) together with a small `baselines.journal` beside it. The journal holds the newest changes until they are folded into the settings file, so keep, back up and restore the two files together; the journal is absent when there is nothing to fold in.
- If a save succeeds but warns that its local version label could not be refreshed, the Center draft was saved. A later update attempts a safe refresh of the `rssd-version` label while preserving note edits; do not send another save merely to repair the label. If the warning persists, inspect the note's identity properties and local changes.

## Formatted article and layout preview

With a work open, run **Copy this work as a formatted article** (also in the status-bar menu), then paste into a rich-text editor. The output is tuned for the WeChat official-account editor but is not tied to it. The styling comes from the website's own export engine (`web/engine/browser-export/wechat-clipboard.mjs` in RSSD). Images from `article-media/` travel inside the copied content as JPEG or PNG. The title is not part of the body: put it in the editor's title field. This only fills the clipboard; nothing is sent to the Center or to any platform.

The four RSSD tabs open in the note's own tab bar, next to the note, where each has the full width: from the open work's card in the Works list (each button has its tab's icon), from the commands, or from the note's menu. Each tab is named for what it shows and the work, for example "Article · 生存分析如何读懂未完的随访". A second one opens next to the first, and a tab you drag elsewhere reopens there. The right sidebar is left to Obsidian. **Article** and **Cards** are the outputs. Each follows the work you have open and refreshes after edits, and has one row: first **Default**, the site's own style, then the general themes as numbered squares in the section's colour (hover a number for its name), and refresh and copy or save at the right. The article preview has no frame or fixed width (as it lands in an editor). **Outline** lists the work's headings and brings the note to the front at the one you choose; **Details** edits the readers' fields (title, summary, date, author, category) with a count against each output's limit, lists what still needs filling, and shows the read-only fields that link the note to its Center work. A tab behind another is only built when you show it. Because the details have this place, the properties block at the top of each note is hidden (Settings → RSSD → *Properties in the article* shows it again). A vault arranged by an earlier version has its RSSD tabs closed once where that version put them (the right sidebar, or a pane of their own beside the note); they open next to the note from then on. Obsidian's own right-sidebar tabs that an earlier version closed can be reopened from the command palette. The copied article has no outer card, border or width of its own: it fills the editor's column, long links and code wrap, and pictures never exceed the column or their own size.

Each work takes the colours, fonts and heading mark of its space and section from the website's templates (`web/themes/export/templates/` in RSSD), which are bundled when the plugin is built; a work in a section without a template uses the default look. On top of that, each site has its own design (`src/wechat-designs.mjs`): how a chapter opens, how the site signs its name above and below the article (name and slogan come from `sites/profiles.json`), and how bold terms and inline code read. Second-level headings are the chapters; a heading such as 参考文献 stays quiet and unnumbered.

The **Cards** tab lays the same work out as picture cards: 3:4 PNG images of 1080×1440, with the site name and section across the top, the site's address and the card number at the bottom, and the section's own page layout and colours. Layout and drawing are the website's page engine (`web/engine/browser-export/pagination.mjs` and `raster.mjs`), which refuses to produce a set that lost any text or picture. **Save cards** (or the command **Save this work as cards**) writes a package into the vault at `Exports/cards/<note name>/`: the numbered pictures, `caption.txt` (title and summary) and `manifest.json`. Saving again replaces that folder's cards. Nothing is sent anywhere. Cards use the fonts on the computer that draws them, and a picture hosted on another site is left out and listed in the manifest.

Formulas are written the way the website writes them: `$…$`, `$$…$$`, `\(…\)` or `\[…\]`. Obsidian's own editor only draws the dollar forms, but both views draw every form with the website's KaTeX version (bundled, with its fonts) and carry each formula as a picture: a sharp PNG in the copied article, a vector picture on a card. An inline formula sits on the text baseline; a display formula is centred on its own line. In the article's plain text a formula is its LaTeX source. A formula delimiter left unclosed leaves the formulas as text and is listed in the manifest.

Every output also has a package manifest, defined in RSSD's `contracts/output-package.mjs`: the format, article, language, site, section and style, the source version and a hash of the source it was made from, and the fields the platform asks for besides the body (for WeChat: title, a digest of at most 120 characters, author and cover). The layout preview shows how many items the manifest flags, such as a missing author or cover or a shortened digest; hover the text to read them. The manifest is built in memory for now; nothing is written to the vault.

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

## Works list

The left sidebar's **Works** tab lists every work of the space, newest first by the work's own date, each with its section as a coloured label before the title. Search covers titles and summaries. The filter button beside it opens a floating filter panel, and every change applies at once: **Show** All, **Edited** (changed since the last sync with the Center) or **To check** (still missing an author or category); **Language**, 中文 or English, when the space has English editions; **Section**, **Agent**, **Model** and **Machine**, where several can be ticked and any of them matches; and **Date**, a from–to range with quick choices for the last 7 or 30 days and this month. The count beside each option is how many works it would list with the other choices kept. The button shows how many filters are in force, each filter shows as a chip under the search box that removes it, and the filter is remembered on this device. Within a filter any chosen value matches; across filters all must (`src/works-filter.mjs`). Each work is a card. Its chips name only what needs attention: Edited, Saving, a conflict, a note not yet updated from the Center, and a missing author or category; a work with nothing to attend to has no chip. What the website shows is not on the card. Beneath them the card describes the work: its date, length (Chinese characters plus Latin words, or words for English editions), number of images, number of references (entries under a 参考文献 or References heading, plus footnotes), whether the site's brand line is mounted (an entry that links to the site's home page, usually the last reference), and whether the Center has the same work in the other language (known after an **Update**, for works the Center created in both languages). The last line is the agent and model that wrote the work, for example "Codex · 6.1 Terra" (one name per model, without its reasoning level, however the record wrote it), read once per version from the private writing record the Center keeps with each edition and kept on this device; "Writer not recorded" means the Center has none. Beside it is the machine that saved the work's first version, by the name its device was registered with in the Center (from the same private-notes reply, `firstMachine`; a Center without it leaves the machine out, and it is asked again in the next session). Clicking a card replaces the work everywhere: it opens in the note tab the plug-in used last, every RSSD tab switches to it, and whichever tab was in front stays in front; ⌘-click (Ctrl-click) opens it in a new note tab and leaves the others alone. The open work's card carries **Preview**, **Cards**, **Outline** and **Details**, each with its tab's icon, plus **Save** when it is edited. The button beside the search box switches to one line per work, where the dot is the local state: green synced, orange edited, blue saving, red conflict, grey not updated from the Center yet. Each device remembers its own choice. The footer shows when the space was last updated, then two buttons: **Update** gets the Center's latest versions, and **Save** sends the edited works in the language on screen to the Center as private drafts, one after another, using the same save as the one-work command. Nothing is published. Save shows the count (for example "Save 3") and is greyed out while nothing is edited, or on mobile. A refused work (for example a conflict) is marked red and the rest continue; a space that refuses saves or a lost connection stops the batch. Everything is read from the vault, so the list is instant and works offline; whether the Center has a newer version still comes from an update. Obsidian's file tree stays available as another tab.

## Output themes

The site's own style is the theme that matches the layout the website gives the work's section, in the section's colours and fonts, signed with the site's name marks at the top and bottom. The general themes are shared by every site and carry only the section's colours and fonts:

| Article | Theme | For |
|---|---|---|
| 1 | Classic | essays and reflections |
| 2 | Journal | academic and reference writing |
| 3 | Briefing | news and briefs |
| 4 | Technical | methods, tutorials and data |
| 5 | Visual | picture-led stories |

| Cards | Theme | Cards |
|---|---|---|
| Default | Text | the website's own page layout for the section, in reading order |
| 1 | Key points | one chapter per card, in larger type |
| 2 | Pictures | one picture per card with its description |
