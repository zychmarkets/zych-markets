'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {CatalogLoader}=require('../js/services/catalog-loader'),watch=require('../js/services/watchlist-markets'),instruments=require('../js/services/instrument-search');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const market=(exchange,symbol,baseAsset='BTC',quoteAsset='USD')=>instruments.normalize({exchange,symbol,baseAsset,quoteAsset,marketType:'spot',enabled:true});
const kraken=market('kraken','XXBTZUSD'),bingx=market('bingx','BTC-USDT','BTC','USDT');
const saved=watch.entry(kraken);
function fixture(adapters){
  let items=[saved],markets=[],snapshots={},persisted=JSON.stringify(items);const events=[];
  const loader=new CatalogLoader(adapters,{onCatalog(exchange,rows){markets=markets.filter(row=>row.exchange!==exchange).concat(rows);items=watch.migrate(items,{markets});persisted=JSON.stringify(items);events.push(['catalog',exchange]);},onQuotes(exchange,rows){for(const row of rows)snapshots[row.marketId]=row;events.push(['quotes',exchange]);}});
  return{loader,events,view:()=>watch.view(items,markets,loader.states,snapshots),remove(){items=items.filter(row=>row.key!==saved.key);persisted=JSON.stringify(items);},saved:()=>JSON.parse(persisted)};
}
test('saved Kraken row is visible during slow catalog, then resolves before slow quotes and other exchanges',async()=>{
  const catalog=deferred(),quotes=deferred(),other=deferred();
  const f=fixture({kraken:{discover:()=>catalog.promise,allSnapshots:()=>quotes.promise},bingx:{discover:()=>other.promise,allSnapshots:async()=>[]}});
  const run=f.loader.start();let row=f.view()[0];assert.equal(row.status,'catalogLoading');assert.equal(row.resolved,false);assert.equal(row.market.symbol,'XXBTZUSD');assert.equal(row.market.exchange,'kraken');assert.equal(row.market.marketType,'spot');assert.equal(row.snapshot,null);
  catalog.resolve([kraken]);await f.loader.wait('kraken');await tick();row=f.view()[0];assert.equal(row.status,'quotesLoading');assert.equal(row.resolved,true);assert.equal(row.market.id,saved.key);assert.deepEqual(f.events,[['catalog','kraken']]);
  quotes.resolve([{marketId:kraken.id,lastPrice:123,changePercent:null}]);await tick();assert.equal(f.view()[0].status,'ready');assert.equal(f.view()[0].snapshot.lastPrice,123);
  other.resolve([bingx]);await run;f.loader.dispose();
});
test('one failed catalog does not block another exchange; error and missing pair are distinct',async()=>{
  const f=fixture({kraken:{discover:async()=>{throw Error('offline')}},bingx:{discover:async()=>[bingx],allSnapshots:async()=>[]}});
  await f.loader.start();assert.equal(f.view()[0].status,'catalogError');assert.deepEqual(f.saved(),[saved]);assert.equal(f.loader.states.bingx.catalog,'ready');
  const missing=watch.view([saved],[market('kraken','XBTUSDT','BTC','USDT')],{kraken:{catalog:'ready',quotes:'ready'}})[0];assert.equal(missing.status,'notFound');assert.equal(missing.resolved,false);assert.equal(missing.market.symbol,'XXBTZUSD');f.loader.dispose();
});
test('quote rejection and missing price terminate loading without invented zero metrics',async()=>{
  const f=fixture({kraken:{discover:async()=>[kraken],allSnapshots:async()=>{throw Error('offline')}}});await f.loader.start();await tick();assert.equal(f.view()[0].status,'quotesError');assert.equal(f.view()[0].resolved,true);
  for(const value of [null,undefined,'',' ',NaN,Infinity,false,[]]){assert.equal(watch.finite(value),false);assert.equal(watch.view([saved],[kraken],{kraken:{catalog:'ready',quotes:'ready'}},{[kraken.id]:{lastPrice:value}})[0].status,'quotesUnavailable');}
  assert.equal(watch.finite(0),true);f.loader.dispose();
});
test('removing pending entry survives late catalog, late quotes and persistence reload',async()=>{
  const catalog=deferred(),quotes=deferred(),f=fixture({kraken:{discover:()=>catalog.promise,allSnapshots:()=>quotes.promise}});const run=f.loader.start();
  assert.deepEqual(watch.migrate(f.saved(),{markets:[]}),[saved]);f.remove();catalog.resolve([kraken]);await run;quotes.resolve([{marketId:kraken.id,lastPrice:123}]);await tick();assert.deepEqual(f.view(),[]);assert.deepEqual(f.saved(),[]);assert.deepEqual(watch.migrate(f.saved(),{markets:[kraken]}),[]);f.loader.dispose();
});
test('superseded catalog and quote results cannot publish into a new load generation',async()=>{
  const oldCatalog=deferred(),oldQuotes=deferred();let call=0;const publications=[];
  const loader=new CatalogLoader({kraken:{discover:()=>++call===1?oldCatalog.promise:Promise.resolve([kraken]),allSnapshots:()=>oldQuotes.promise}},{onCatalog:(exchange,rows)=>publications.push(rows)});
  const old=loader.start();await tick();await loader.start();oldCatalog.resolve([bingx]);await old;assert.deepEqual(publications,[[kraken]]);loader.dispose();oldQuotes.resolve([]);await tick();assert.equal(loader.states.kraken.quotes,'loading');
});
test('concurrent quote refreshes coalesce and disposed quote data is not applied',async()=>{
  const quotes=deferred();let calls=0,published=0;const loader=new CatalogLoader({kraken:{discover:async()=>[kraken],allSnapshots:()=>{calls++;return quotes.promise}}},{onQuotes:()=>published++});
  await loader.start();await tick();const first=loader.refresh('kraken'),second=loader.refresh('kraken');assert.equal(first,second);assert.equal(calls,1);loader.dispose();quotes.resolve([{marketId:kraken.id,lastPrice:123}]);await first;assert.equal(published,0);
});
test('pending row markup allows removal but has no chart identity or enabled chart action',()=>{
  const source=fs.readFileSync(require.resolve('../app.js'),'utf8'),context={ZychI18n:{t:key=>key},watchRadarEvent:()=>null,assetMeta:()=>({name:'Bitcoin'}),escapeHtml:String,EXCHANGES:{kraken:{label:'Kraken'}},ZychWatchlist:watch,ZychAlertCore:{SUPPORTED_EXCHANGES:['kraken']},iconMarkup:()=>'',formatPrice:value=>value==null?'—':String(value),formatPercent:value=>value==null?'—':String(value),formatCompact:String};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  const watchRowMarkup='),source.indexOf('  function renderWatchlist()'))+'\nthis.rowMarkup=watchRowMarkup;this.tileMarkup=watchTileMarkup;',context);
  const row=watch.view([saved],[],{kraken:{catalog:'loading'}})[0];for(const markup of [context.rowMarkup(row),context.tileMarkup(row)]){assert.match(markup,/XXBTZUSD/);assert.match(markup,/catalogLoading/);assert.doesNotMatch(markup,/data-market-id=/);assert.doesNotMatch(markup,/>0(?:%|<)/);}
  assert.match(context.rowMarkup(row),/data-remove-watch="kraken:spot:XXBTZUSD"/);assert.match(context.rowMarkup(row),/data-watch-chart="" disabled/);
  context.state={watchlist:[saved]};let persisted;Object.assign(context,{saveWatchlist:()=>persisted=JSON.stringify(context.state.watchlist),renderWatchlist(){},renderMarket(){},renderMarketsDashboard(){},searchResults:{hidden:true}});
  vm.runInContext(source.slice(source.indexOf('  function removeWatchlistEntry('),source.indexOf("  const watchlistWorkspace=")),context);context.removeWatchlistEntry(saved.key);assert.equal(persisted,'[]');
});
test('late quotes after exchange switch update only exact market cache, not selected market or Watchlist',()=>{
  const source=fs.readFileSync(require.resolve('../app.js'),'utf8'),selected=bingx;
  const context={MARKETS:[kraken,bingx],state:{activeExchange:'bingx',selectedMarket:selected,watchlist:[],marketSnapshots:{}},ZychSnapshotReliability:{evaluate:()=>({})},marketForAsset:()=>null,updatePulse(){},renderMarket(){},renderWatchlist(){},renderMarketsDashboard(){},searchResults:{hidden:true}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  function publishQuotes('),source.indexOf('  async function refreshSnapshots()')),context);
  context.publishQuotes('kraken',[{marketId:kraken.id,lastPrice:123},{marketId:bingx.id,lastPrice:999}]);
  assert.equal(context.state.marketSnapshots[kraken.id].lastPrice,123);assert.equal(context.state.marketSnapshots[bingx.id],undefined);assert.equal(context.state.activeExchange,'bingx');assert.equal(context.state.selectedMarket,selected);assert.deepEqual(context.state.watchlist,[]);
});
test('old quotes completing after a newer catalog generation cannot replace current quotes',async()=>{
  const old=deferred();let calls=0;const prices=[];const loader=new CatalogLoader({kraken:{discover:async()=>[kraken],allSnapshots:()=>++calls===1?old.promise:Promise.resolve([{marketId:kraken.id,lastPrice:200}])}},{onQuotes:(_,rows)=>prices.push(rows[0].lastPrice)});
  await loader.start();await tick();await loader.start();await tick();old.resolve([{marketId:kraken.id,lastPrice:100}]);await tick();assert.deepEqual(prices,[200]);assert.equal(loader.states.kraken.quotes,'ready');loader.dispose();
});
