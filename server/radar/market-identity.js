'use strict';
const MARKET_TYPES=Object.freeze(['spot','perpetual']);
const normalizePart=value=>String(value||'').trim();
const marketId=({exchange,marketType,symbol})=>`${normalizePart(exchange).toLowerCase()}:${normalizePart(marketType).toLowerCase()}:${normalizePart(symbol).toUpperCase()}`;
const legacyMarketId=({exchange,symbol})=>`${normalizePart(exchange).toLowerCase()}:${normalizePart(symbol).toUpperCase()}`;
const aliases=market=>[marketId(market),legacyMarketId(market)];
const matches=(market,id)=>aliases(market).includes(String(id||''));
module.exports={MARKET_TYPES,marketId,legacyMarketId,aliases,matches};
