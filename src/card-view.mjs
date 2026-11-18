// How the Cards tab looks at a finished set of pictures. The sizes are fractions of a
// card's real width (1080px). "fit" leaves the size to the pane.
export const CARD_ZOOMS=Object.freeze([0.5,0.75,1,1.5]);

/** An index that always names a card in the set, or 0 when the set is empty. */
export function clampCardIndex(index,count){
 const total=Math.max(0,count|0);
 if(!total)return 0;
 const n=Math.trunc(Number(index));
 if(!Number.isFinite(n)||n<0)return 0;
 return Math.min(total-1,n);
}

/**
 * The next zoom. Zooming out from the smallest size returns to fit; zooming in
 * from fit enters the smallest size. The largest size stays put.
 */
export function stepCardZoom(zoom,direction){
 const dir=direction<0?-1:1;
 if(zoom==='fit')return dir<0?'fit':CARD_ZOOMS[0];
 const current=CARD_ZOOMS.reduce((best,step)=>Math.abs(step-zoom)<Math.abs(best-zoom)?step:best,CARD_ZOOMS[0]);
 const index=CARD_ZOOMS.indexOf(current)+dir;
 if(index<0)return 'fit';
 if(index>=CARD_ZOOMS.length)return CARD_ZOOMS.at(-1);
 return CARD_ZOOMS[index];
}
