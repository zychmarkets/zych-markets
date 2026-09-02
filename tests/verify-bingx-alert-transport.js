'use strict';
// Read-only live protocol check. No alert storage, runner, credentials or owner data.
const {BingxMarketTransport,decodeFrame}=require('../server/transports/bingx-market-transport');
const market={marketId:'bingx:spot:BTC-USDT',exchange:'bingx',marketType:'spot',symbol:'BTC-USDT',baseAsset:'BTC',quoteAsset:'USDT'};
const seen=new Set(),transport=new BingxMarketTransport({logger:console,decode:async frame=>{const text=await decodeFrame(frame);if(text.includes('@lastPrice')&&!seen.has('rawPrice')){seen.add('rawPrice');console.log(JSON.stringify({rawPrice:text}));}return text;}});
const timer=setTimeout(async()=>{console.log(JSON.stringify({diagnostics:transport.diagnostics()}));await transport.stop();},40000);
transport.start([{...market,type:'price',condition:{type:'price',operator:'above',value:1}},{...market,type:'volume',condition:{type:'volume',timeframe:'5m',multiplier:1000}}],{onStatus:status=>console.log(JSON.stringify({status})),onEvent:event=>{if(!seen.has(event.eventType)){seen.add(event.eventType);console.log(JSON.stringify({event}));}}}).catch(async error=>{clearTimeout(timer);console.error(error);await transport.stop();process.exitCode=1;});
