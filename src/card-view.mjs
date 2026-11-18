// How the Cards tab looks at a finished set of pictures: one card at a time, or all of them
// as tiles. Sizes are fractions of a card's real width.
export const CARD_WIDTH=1080,CARD_HEIGHT=1440;
/** The width a card has on a phone, where cards are read. The article preview uses the same column. */
export const PHONE_ZOOM=375/CARD_WIDTH;
/** A fitted card is never larger than this: half size is exact on a 2x screen and still close to a phone. */
export const FIT_LIMIT=0.5;
/** Sizes for one card: a phone, half size, and the picture's own pixels. "fit" sits among them by its size. */
export const PAGE_ZOOMS=Object.freeze([PHONE_ZOOM,0.5,1]);
/** Tile sizes for all cards: small enough to see the set, then the sizes for reading. */
export const TILE_ZOOMS=Object.freeze([0.2,PHONE_ZOOM,0.5,1]);

/** An index that always names a card in the set, or 0 when the set is empty. */
export function clampCardIndex(index,count){
 const total=Math.max(0,count|0);
 if(!total)return 0;
 const n=Math.trunc(Number(index));
 if(!Number.isFinite(n)||n<0)return 0;
 return Math.min(total-1,n);
}

/** The widest a whole card can be in a pane of this size, in CSS pixels. */
export function fitCardWidth(paneWidth,paneHeight,padding=16){
 const byWidth=paneWidth-2*padding,byHeight=(paneHeight-2*padding)*CARD_WIDTH/CARD_HEIGHT;
 const width=Math.floor(Math.min(byWidth,byHeight,CARD_WIDTH*FIT_LIMIT));
 return Number.isFinite(width)?Math.max(120,width):120;
}

/**
 * The next size for one card. "fit" takes its place among the fixed sizes by how large it is
 * in this pane, so zooming in always enlarges and zooming out always shrinks. The ends stay put.
 */
export function stepCardZoom(zoom,direction,fitScale){
 const dir=direction<0?-1:1,fit=Number.isFinite(fitScale)&&fitScale>0?fitScale:0;
 const current=zoom==='fit'?fit:Number(zoom);
 // Fit comes first, so when it is exactly a fixed size the control reads "fit" there.
 const stops=[{value:'fit',size:fit},...PAGE_ZOOMS.map(value=>({value,size:value}))]
  .filter(stop=>dir>0?stop.size>current+1e-6:stop.size<current-1e-6)
  .sort((a,b)=>dir*(a.size-b.size));
 return stops.length?stops[0].value:zoom;
}

/** The next tile size when all cards are shown. The ends stay put. */
export function stepTileZoom(zoom,direction){
 const dir=direction<0?-1:1,current=Number(zoom);
 const stops=TILE_ZOOMS.filter(value=>dir>0?value>current+1e-6:value<current-1e-6);
 return stops.length?(dir>0?stops[0]:stops.at(-1)):zoom;
}

/** What the size control shows. */
export function zoomLabel(zoom){
 if(zoom==='fit')return '适应';
 if(Math.abs(Number(zoom)-PHONE_ZOOM)<1e-6)return '手机';
 return Math.round(Number(zoom)*100)+'%';
}
