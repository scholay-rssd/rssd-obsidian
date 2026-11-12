// Each space's WeChat look, taken from the RSSD website at build time (see build-templates.mjs): the section
// templates give colours and fonts, the site profiles give the name and slogan each site signs with. A build
// without them, or a work in an unknown section, falls back to the engine's default colours and no design.
import {renamedSiteId} from '../../contracts/site-renames.mjs';

export const WECHAT_TEMPLATES=typeof RSSD_WECHAT_TEMPLATES==='object'&&RSSD_WECHAT_TEMPLATES?RSSD_WECHAT_TEMPLATES:{};
export const CARD_TEMPLATES=typeof RSSD_CARD_TEMPLATES==='object'&&RSSD_CARD_TEMPLATES?RSSD_CARD_TEMPLATES:{};
export const WECHAT_SITES=typeof RSSD_WECHAT_SITES==='object'&&RSSD_WECHAT_SITES?RSSD_WECHAT_SITES:{};
const own=(object,key)=>object&&typeof key==='string'&&Object.prototype.hasOwnProperty.call(object,key)?object[key]:undefined;

/** The site a space publishes as: {id,name,slogan}, or null when the build does not know the space. */
export function wechatSite(space,sites=WECHAT_SITES){
 // A Center space may still carry a retired site ID (lingxi → xsime).
 const site=own(sites,space)||own(sites,renamedSiteId(space));
 return site&&typeof site==='object'&&typeof site.id==='string'?{...site}:null;
}
/** The template for a work's space and section, or null when there is none. */
export function wechatTemplate(space,sectionId,table=WECHAT_TEMPLATES,sites=WECHAT_SITES){
 const template=own(own(table,wechatSite(space,sites)?.id||space),sectionId);
 return template&&typeof template==='object'?{...template}:null;
}
/** The page (card) template for a work's space and section, or null when there is none. */
export function cardTemplate(space,sectionId,table=CARD_TEMPLATES,sites=WECHAT_SITES){
 const template=own(own(table,wechatSite(space,sites)?.id||space),sectionId);
 return template&&typeof template==='object'?{...template}:null;
}
