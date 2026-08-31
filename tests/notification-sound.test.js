const test=require('node:test');
const assert=require('node:assert/strict');

const node=()=>({children:[],className:'',textContent:'',setAttribute(){},addEventListener(){},append(...items){this.children.push(...items)},remove(){this.removed=true}});

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
