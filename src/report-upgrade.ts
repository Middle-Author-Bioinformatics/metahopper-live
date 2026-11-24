// Older reports keep BinaRena selections private. Add the same narrow browsing
// API as the current generator, inside its recognized closure. Scientific data
// and manual assignments are untouched; unfamiliar report versions stay intact.
export function upgradeBinarenaView(html: string): string {
  const marker = "window.addEventListener('resize', function(){ if (view.length) draw(); });";
  if (html.includes('window.MHBinarenaView') || !html.includes('var sub = Object.create(null), order = [], selected = new Set()')
      || !html.includes(marker)) return html;
  return html.replace(marker, marker + `
  window.MHBinarenaView = {
    capture:function(){return Array.from(selected);},
    restore:function(ids){selected.clear();(ids||[]).forEach(function(id){if(IDX[id]!==undefined)selected.add(id);});draw();},
    reset:function(){selected.clear();rebuild();}
  };`);
}
