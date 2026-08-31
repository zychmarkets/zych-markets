const test=require('node:test');
const assert=require('node:assert/strict');

const node=()=>({children:[],listeners:{},className:'',textContent:'',setAttribute(){},addEventListener(type,handler){this.listeners[type]=handler},append(...items){this.children.push(...items)},remove(){this.removed=true}});

test('one real trigger notification dispatches the configured sound exactly once',async()=>{
  const originalDocument=global.document;global.document={createElement:node};
  try{
    const {NotificationCenter}=require('../js/notifications/notification-center.js');let plays=0;
    const center=new NotificationCenter({region:{append(){}},sound:{play:async()=>{plays++;return true}},describe:()=> 'Price above',formatTime:()=> '12:00',onOpen(){},setTimer:()=>0});
    center.notify({asset:'BTC',exchange:'bybit',timeframe:'1m',triggeredAt:1});await Promise.resolve();assert.equal(plays,1);
  }finally{global.document=originalDocument}
});

test('sound rejection is isolated from trigger notification rendering',async()=>{
  const originalDocument=global.document,originalWarn=console.warn;global.document={createElement:node};let warnings=0;console.warn=()=>warnings++;
  try{const {NotificationCenter}=require('../js/notifications/notification-center.js');assert.doesNotThrow(()=>new NotificationCenter({region:{append(){}},sound:{play:()=>Promise.reject(new Error('blocked'))},describe:()=>'',formatTime:()=>'',onOpen(){},setTimer:()=>0}).notify({asset:'BTC',exchange:'bybit',triggeredAt:1}));await new Promise(resolve=>setImmediate(resolve));assert.equal(warnings,1)}
  finally{global.document=originalDocument;console.warn=originalWarn}
});

test('the same TriggerEvent id cannot replay a toast or sound',async()=>{const originalDocument=global.document;global.document={createElement:node};try{const {NotificationCenter}=require('../js/notifications/notification-center.js');let plays=0,toasts=0;const center=new NotificationCenter({region:{append(){toasts++}},sound:{play:()=>{plays++;return true}},describe:()=>'',formatTime:()=>'',onOpen(){},setTimer:()=>0}),event={id:'stable-trigger',asset:'BTC',exchange:'binance',triggeredAt:1};assert.ok(center.notify(event));assert.equal(center.notify(event),null);await Promise.resolve();assert.equal(toasts,1);assert.equal(plays,1)}finally{global.document=originalDocument}});

test('toast auto-dismisses after eight seconds without removing trigger history',()=>{const originalDocument=global.document;global.document={createElement:node};try{const {NotificationCenter}=require('../js/notifications/notification-center.js'),timers=[],history=[{id:'auto'}],center=new NotificationCenter({region:{append(){}},sound:{play(){}},describe:()=>'',formatTime:()=>'',onOpen(){},setTimer:(callback,delay)=>{timers.push({callback,delay});return 1},clearTimer(){}}),toast=center.notify({...history[0],asset:'BTC',exchange:'binance',triggeredAt:1});assert.equal(timers[0].delay,8000);assert.equal(toast.removed,undefined);timers[0].callback();assert.equal(toast.removed,true);assert.deepEqual(history.map(event=>event.id),['auto'])}finally{global.document=originalDocument}});

test('native-style browser timers keep their required global receiver',()=>{const originalDocument=global.document,originalSetTimeout=global.setTimeout,originalClearTimeout=global.clearTimeout,timers=[];global.document={createElement:node};global.setTimeout=function(callback,delay){assert.equal(this,global);timers.push({callback,delay});return 17};global.clearTimeout=function(timer){assert.equal(this,global);assert.equal(timer,17)};try{const {NotificationCenter}=require('../js/notifications/notification-center.js'),center=new NotificationCenter({region:{append(){}},sound:{play(){}},describe:()=>'',formatTime:()=>'',onOpen(){}}),toast=center.notify({id:'browser-timer',asset:'BTC',exchange:'binance',triggeredAt:1});assert.equal(timers[0].delay,8000);timers[0].callback();assert.equal(toast.removed,true)}finally{global.document=originalDocument;global.setTimeout=originalSetTimeout;global.clearTimeout=originalClearTimeout}});

test('manual close dismisses immediately and does not alter history',()=>{const originalDocument=global.document;global.document={createElement:node};try{const {NotificationCenter}=require('../js/notifications/notification-center.js'),history=[{id:'manual'}],center=new NotificationCenter({region:{append(){}},sound:{play(){}},describe:()=>'',formatTime:()=>'',onOpen(){},setTimer:()=>1,clearTimer(){}}),toast=center.notify({...history[0],asset:'BTC',exchange:'binance',triggeredAt:1}),close=toast.children[3];let stopped=false;close.listeners.click({stopPropagation(){stopped=true}});assert.equal(stopped,true);assert.equal(toast.removed,true);assert.deepEqual(history.map(event=>event.id),['manual'])}finally{global.document=originalDocument}});

test('two unique TriggerEvents have independent toast timers',async()=>{const originalDocument=global.document;global.document={createElement:node};try{const {NotificationCenter}=require('../js/notifications/notification-center.js'),timers=[],toasts=[];let plays=0;const center=new NotificationCenter({region:{append(toast){toasts.push(toast)}},sound:{play(){plays++}},describe:()=>'',formatTime:()=>'',onOpen(){},setTimer:callback=>{timers.push(callback);return timers.length},clearTimer(){}});center.notify({id:'one',asset:'BTC',exchange:'binance',triggeredAt:1});center.notify({id:'two',asset:'ETH',exchange:'binance',triggeredAt:2});assert.equal(toasts.length,2);assert.equal(timers.length,2);timers[0]();assert.equal(toasts[0].removed,true);assert.equal(toasts[1].removed,undefined);timers[1]();assert.equal(toasts[1].removed,true);await Promise.resolve();assert.equal(plays,2)}finally{global.document=originalDocument}});
