// Test-harness UI: explicit user-triggered matrix over the real product DOM.
document.getElementById('run').onclick=async()=>{
  const output=document.getElementById('results'),frame=document.getElementById('product'),results=[];
  const pause=()=>new Promise(resolve=>setTimeout(resolve,120));
  for(const [width,height]of [[1024,768],[1280,800],[1366,768],[1536,900],[1920,1080]])for(const zoom of [.9,1,1.1,1.25]){
    frame.style.width=Math.round(width/zoom)+'px';frame.style.height=Math.round(height/zoom)+'px';
    await new Promise(resolve=>{frame.onload=resolve;frame.src=`/?fixture=1&viewport=${width}-${height}-${zoom}#radar`;});
    const doc=frame.contentDocument;
    for(let i=0;i<40&&Number(doc.documentElement.dataset.universeMarkets)!==11;i++)await pause();
    const selector=doc.getElementById('active-exchange-selector'),search=doc.getElementById('coin-search');
    const measure=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};};
    let baseline=null;
    for(const page of ['radar','markets','watchlist','chart','markets']){
      doc.querySelector(`.topbar a[href="#${page}"]`).click();await pause();
      const selected=measure(selector),box=measure(search),header=doc.querySelector('.topbar'),buttons=[...header.querySelectorAll('button,a,input')].filter(e=>e.getBoundingClientRect().width>0);
      baseline??={selected,box};
      const stable=Math.abs(selected.x-baseline.selected.x)<1&&Math.abs(selected.y-baseline.selected.y)<1&&Math.abs(box.x-baseline.box.x)<1&&Math.abs(box.y-baseline.box.y)<1;
      const overflow=doc.documentElement.scrollWidth>doc.documentElement.clientWidth+1;
      const collision=buttons.some(e=>e!==search&&!e.contains(search)&&!search.contains(e)&&(()=>{const r=e.getBoundingClientRect();return r.x<box.right&&r.right>box.x&&r.y<box.y+box.height&&r.bottom>box.y;})());
      const initialized=Number(doc.documentElement.dataset.universeMarkets)===11&&doc.documentElement.dataset.workspaceView===page&&doc.querySelectorAll('#chart canvas').length>0;
      results.push({width,height,zoom,page,initialized,viewport:doc.documentElement.clientWidth,selectorCount:doc.querySelectorAll('#active-exchange-selector').length,options:doc.querySelectorAll('[data-active-exchange-option]').length,stable,overflow,collision,selector:selected,search:box});
      output.textContent=JSON.stringify({completed:results.length,failures:results.filter(r=>!r.initialized||!r.stable||r.overflow||r.collision||r.selectorCount!==1||r.options!==6),results},null,2);
    }
  }
  output.dataset.complete='true';
};
