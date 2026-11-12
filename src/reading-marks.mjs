// The proofreading marks the reading view adds to a work note: the context line, picture captions, the reference
// block, the brand line and the internal row notes. They belong to the note's own reading view only. Outputs (the
// Article preview, the WeChat copy and picture cards) render the same note through Obsidian, so its
// post-processors run there too; an output host carries OUTPUT_ATTRIBUTE so the reading view leaves it alone, and
// whatever was decorated before it reached the host is taken out again by stripReadingMarks.

/** Set on the element an output is rendered into. */
export const OUTPUT_ATTRIBUTE='data-rssd-output';
/** Elements the reading view adds: removed from an output. The row-note box holds internal notes. */
export const ADDED_MARKS='.rssd-context,.rssd-figcaption,.rssd-row-note-mark,.rssd-row-note-box';
/** Classes the reading view puts on rendered blocks: taken off in an output. */
export const MARK_CLASSES=Object.freeze(['rssd-reference-block','rssd-brand-line']);

/** Whether a rendered block is part of an output rather than a note's reading view. */
export const inOutput=el=>!!el?.closest?.('['+OUTPUT_ATTRIBUTE+']');

/** Takes every reading-view mark out of an output that has been rendered into `root`. Returns how many it removed. */
export function stripReadingMarks(root){
 let removed=0;
 for(const node of [...root.querySelectorAll(ADDED_MARKS)]){node.remove();removed++;}
 for(const name of MARK_CLASSES)for(const node of [root,...root.querySelectorAll('.'+name)])node.classList.remove(name);
 for(const node of [...root.querySelectorAll('[data-rssd-row-note]')])node.removeAttribute('data-rssd-row-note');
 root.removeAttribute(OUTPUT_ATTRIBUTE);
 return removed;
}
