// TEST ONLY: deterministic adapters exercise the real product render/navigation.
// No public feed, browser-side alert execution, or owner storage access.
(() => {
  const markets=ZychSixExchangeFixture.markets;
  localStorage.setItem('zych.watchlist.v1',JSON.stringify(markets.slice(0,7).map(ZychWatchlist.entry)));
  localStorage.setItem('zych.exchange-workspace.v1',JSON.stringify({exchange:'kraken',marketId:'kraken:spot:XXBTZUSD',asset:'BTC',quoteAsset:'USD',timeframe:'1m'}));
  for(const [exchange,adapter]of Object.entries(ZychExchanges.adapters)){
    const selected=markets.filter(m=>m.exchange===exchange),limited=adapter.capabilities?.exactQuoteVolume24h===false;
    const snapshots=()=>selected.map((market,i)=>({...ZychMarketsData.snapshot({price:77000+i,change24h:i%2?-1:2,quoteVolume24h:limited?null:1234567,high:78000,low:76000,snapshotTimestamp:Date.now()}),marketId:market.id,baseVolume24h:42,receivedAt:Date.now()}));
    adapter.discover=async()=>selected;
    adapter.allSnapshots=async()=>snapshots();
    adapter.snapshots=async requested=>Object.fromEntries(snapshots().filter(row=>requested.some(m=>m.id===row.marketId)).map(row=>[row.marketId,row]));
    adapter.cachedSnapshot=symbol=>snapshots().find(row=>row.marketId===`${exchange}:spot:${symbol}`)||null;
    adapter.candles=async(market,frame,before)=>{if(adapter.capabilities?.intervals&&!adapter.capabilities.intervals.includes(frame))throw Error('Unsupported fixture interval');const step=({'1m':60,'5m':300,'15m':900,'1h':3600,'4h':14400,'1d':86400,'1w':604800,'1M':2592000})[frame],end=Math.floor(Date.now()/1000/step)*step;const rows=before?[]:Array.from({length:180},(_,i)=>({time:end-(179-i)*step,open:77000,high:77020,low:76980,close:77000,volume:10}));rows.exhausted=true;return rows;};
    adapter.socket=(_market,_frame,handlers)=>{const socket={readyState:0,close(){socket.readyState=3;handlers.close?.({code:1000});}};queueMicrotask(()=>{if(socket.readyState===3)return;socket.readyState=1;handlers.open?.();handlers.status?.('WAITING');});return socket;};
  }
  const marker=document.createElement('aside');marker.textContent='ISOLATED SYNTHETIC UI FIXTURE — not live market evidence';marker.style='position:fixed;bottom:0;left:0;z-index:9999;font-size:10px;background:#18222a;color:white';document.body.append(marker);
})();
