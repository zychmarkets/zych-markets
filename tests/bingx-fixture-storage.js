// Browser-only ephemeral test fixture. Never reads or writes owner local/session storage.
(() => {
  const fixture=new Map();
  for(const name of ['localStorage','sessionStorage'])Object.defineProperty(window,name,{value:{getItem:key=>fixture.get(name+key)??null,setItem:(key,value)=>fixture.set(name+key,String(value)),removeItem:key=>fixture.delete(name+key)},configurable:true});
  const entry=exchange=>({key:`${exchange}:spot:${exchange==='bingx'?'BTC-USDT':'BTCUSDT'}`,marketId:`${exchange}:spot:${exchange==='bingx'?'BTC-USDT':'BTCUSDT'}`,exchange,marketType:'spot',symbol:exchange==='bingx'?'BTC-USDT':'BTCUSDT',asset:'BTC',baseAsset:'BTC',quoteAsset:'USDT'});
  localStorage.setItem('zych.watchlist.v1',JSON.stringify([entry('binance'),entry('bingx')]));
  localStorage.setItem('zych.exchange-workspace.v1',JSON.stringify({exchange:'binance',marketId:'binance:spot:BTCUSDT',asset:'BTC',quoteAsset:'USDT',timeframe:'1m'}));
})();
