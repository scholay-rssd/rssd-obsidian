// Each column's own variation of its theme. A column's theme follows the layout the website gives it, so columns
// with the same layout would otherwise differ only in colour. Within one site, no two columns share both a theme
// and a variation (the tests hold every column to that). A variation keeps the theme's fonts, sizes and spacing
// and changes three things: the mark that leads a sub-heading, the frame of a quote (every border of the theme's
// frame is cleared first) and the edge of a picture. The site's own style uses them; the numbered general themes
// do not. Pasted editors keep inline styles only, so every piece is a plain span, border or background.

export const VARIANTS=Object.freeze([
 // The theme as it is.
 {id:'plain',label:'Plain',h3Mark:()=>'',quote:()=>'',img:()=>''},
 // A bar before sub-headings, quotes on a tinted panel, pictures mounted with a thin frame.
 {id:'panel',label:'Panel',
  h3Mark:c=>`<span style="display:inline-block;width:4px;height:1em;margin-right:8px;background:${c.accent};border-radius:2px;vertical-align:-2px;"></span>`,
  quote:c=>`border:0;padding:10px 14px;background:${c.tint(.1)};border-radius:8px;`,
  img:c=>`padding:4px;border:1px solid ${c.tint(.3)};background:#fff;box-sizing:border-box;`},
 // A dot before sub-headings, quotes centred between two rules, pictures standing on a coloured base line.
 {id:'ruled',label:'Ruled',
  h3Mark:c=>`<span style="margin-right:6px;font-weight:400;color:${c.accent};">●</span>`,
  quote:c=>`border:0;border-radius:0;padding:12px 8px;border-top:1px solid ${c.tint(.45)};border-bottom:1px solid ${c.tint(.45)};background:transparent;text-align:center;`,
  img:c=>`padding-bottom:6px;border-bottom:3px solid ${c.accent};box-sizing:border-box;`},
 // An open diamond before sub-headings, quotes behind a double line, pictures with soft round corners.
 {id:'soft',label:'Soft',
  h3Mark:c=>`<span style="margin-right:6px;font-weight:400;color:${c.accent};">◇</span>`,
  quote:c=>`border:0;border-radius:0;border-left:4px double ${c.accent};padding:4px 0 4px 14px;background:transparent;`,
  img:()=>`border-radius:14px;`},
]);

/** Each site's columns and the variation each takes (an index into VARIANTS). */
export const COLUMN_VARIANTS=Object.freeze({
 enter:{archive:0,calendar:1,courses:0,forums:0,history:2,'open-source':2,search:0,software:1},
 legis:{archive:1,calendar:1,cases:0,frontiers:0,history:2,ip:0,'open-source':1,regulations:0},
 metho:{archive:0,calendar:1,experiments:0,frontiers:0,history:2,methods:1,'open-source':2,statistics:0},
 personal:{'academic-notes':0,'academic-sites':1,archive:1,calendar:2,history:3,'input-method-projects':0,'keyboard-projects':0,'open-source':3,'open-tools':1,'product-news':0,reflections:0,'website-projects':2,works:1},
 pets:{archive:0,calendar:1,'daily-cat':0,'daily-dog':0,'exotic-pets':0,history:2,'open-source':1,'pet-news':0},
 piggytuck:{archive:0,calendar:1,'design-news':0,history:2,icons:0,'open-source':1,'web-design':0,works:0},
 'scholay-today':{archive:1,briefings:0,calendar:1,collaboration:0,courses:0,history:2,intelligence:1,observations:0,'open-source':2,resources:1},
 study:{archive:0,calendar:2,certificates:0,courses:0,history:3,models:1,offers:0,'open-source':1},
 xsiching:{applications:0,archive:1,calendar:2,classics:0,courses:1,history:3,interpretations:0,'open-source':1},
 xsime:{archive:0,calendar:1,'custom-keyboards':0,development:0,history:2,'input-methods':1,'input-schemes':0,'input-skins':1,'open-source':3,tutorials:2},
});

/** The variation a site's column takes; Plain for a column the table does not know. */
export function columnVariant(siteId,sectionId){
 const site=Object.prototype.hasOwnProperty.call(COLUMN_VARIANTS,siteId)?COLUMN_VARIANTS[siteId]:null;
 const index=site&&Object.prototype.hasOwnProperty.call(site,sectionId)?site[sectionId]:0;
 return VARIANTS[index]||VARIANTS[0];
}
