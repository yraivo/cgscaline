import type {LogoFont} from '../core/model.js';
export const fontNames:Readonly<Record<LogoFont,string>>=Object.freeze({plain:'纯文字','figlet:The Edge':'The Edge'});
export const logoFonts:readonly LogoFont[]=Object.freeze(['plain','figlet:The Edge']);
export function isLogoFont(value:unknown):value is LogoFont{return typeof value==='string'&&Object.hasOwn(fontNames,value);}
export const resolveFont=(value:unknown):LogoFont=>isLogoFont(value)?value:'figlet:The Edge';
export function filterFonts(query=''):LogoFont[]{const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);return logoFonts.filter(key=>words.every(word=>fontNames[key]!.toLowerCase().includes(word)));}
export const gradientSpeeds=Object.freeze([.5,1,2,4,8] as const);
export const resolveGradientSpeed=(value:unknown):number=>typeof value==='number'&&(gradientSpeeds as readonly number[]).includes(value)?value:4;
