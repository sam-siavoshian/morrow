import { SCENE_STORAGE_KEY } from "@/components/sky/scenes";
import { MOTION_STORAGE_KEY } from "@/lib/motion";

// Runs in <head> before first paint: resolves the scene (saved choice, else the
// OS colour scheme) and the motion setting onto <html>, then keeps both in sync
// with OS changes and with other tabs. Only whitelisted values reach the DOM.
const script = `(function(){var d=document.documentElement,S=${JSON.stringify(SCENE_STORAGE_KEY)},M=${JSON.stringify(MOTION_STORAGE_KEY)},dark=matchMedia("(prefers-color-scheme: dark)"),still=matchMedia("(prefers-reduced-motion: reduce)");function get(k){try{return localStorage.getItem(k)}catch(e){return null}}function apply(){var p=get(S),ok=p==="day"||p==="dawn"||p==="night";d.setAttribute("data-theme",ok?p:dark.matches?"night":"day");d.setAttribute("data-theme-pref",ok?p:"system");d.setAttribute("data-motion",still.matches||get(M)==="reduce"?"reduce":"full")}apply();dark.addEventListener("change",apply);still.addEventListener("change",apply);addEventListener("storage",function(e){if(e.key===S||e.key===M||e.key===null)apply()})})()`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
