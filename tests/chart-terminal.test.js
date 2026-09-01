const test=require('node:test');
const assert=require('node:assert/strict');
const terminal=require('../js/services/chart-terminal');

test('chart alert distance is derived from verified current and target prices',()=>{
  assert.deepEqual(terminal.alertDistance(100,112),{difference:12,absolute:12,percent:12,direction:'above'});
  assert.deepEqual(terminal.alertDistance(100,95),{difference:-5,absolute:5,percent:-5,direction:'below'});
  assert.equal(terminal.alertDistance(0,95),null);
});

test('chart hotkeys map only approved interval sequences',()=>{
  assert.equal(terminal.hotkeyInterval('1'),'1m');assert.equal(terminal.hotkeyInterval('15'),'15m');assert.equal(terminal.hotkeyInterval('60'),'1h');assert.equal(terminal.hotkeyInterval('240'),'4h');assert.equal(terminal.hotkeyInterval('30'),null);
});

test('related markets preserve exchange and quote identity',()=>{
  const current={id:'a',exchange:'binance',quoteAsset:'USDT'},markets=[current,{id:'b',exchange:'binance',quoteAsset:'USDT',enabled:true},{id:'c',exchange:'okx',quoteAsset:'USDT',enabled:true},{id:'d',exchange:'binance',quoteAsset:'BTC',enabled:true}];
  assert.deepEqual(terminal.relatedMarkets(markets,current).map(item=>item.id),['b']);
});

test('bottom utility panel defaults by viewport height but preserves explicit session state',()=>{
  assert.equal(terminal.bottomPanelCollapsed(null,768),true);
  assert.equal(terminal.bottomPanelCollapsed(null,899),true);
  assert.equal(terminal.bottomPanelCollapsed(null,900),false);
  assert.equal(terminal.bottomPanelCollapsed('open',768),false);
  assert.equal(terminal.bottomPanelCollapsed('collapsed',1080),true);
});
