(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ZychChartTerminal=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const HOTKEYS={1:'1m',5:'5m',15:'15m',60:'1h',240:'4h'};
  function alertDistance(current,target){current=Number(current);target=Number(target);if(!(current>0)||!Number.isFinite(target))return null;const difference=target-current;return{difference,absolute:Math.abs(difference),percent:difference/current*100,direction:difference>=0?'above':'below'}}
  function hotkeyInterval(value){return HOTKEYS[String(value)]||null}
  function isEditable(target){return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], .search-shell'))}
  function relatedMarkets(markets,current,limit=6){if(!current)return[];return markets.filter(item=>item.enabled&&!item.unavailable&&item.id!==current.id&&item.exchange===current.exchange&&item.quoteAsset===current.quoteAsset).slice(0,limit)}
  return{alertDistance,hotkeyInterval,isEditable,relatedMarkets,notesStorageKey:'zych.chart.notes.v1',panelStorageKey:'zych.chart.bottom.v1'}
});
