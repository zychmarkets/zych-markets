'use strict';
const REASONS=Object.freeze({ACTIVE_MARKET:'ACTIVE_MARKET',INACTIVE_MARKET:'INACTIVE_MARKET',SPOT_MARKET:'SPOT_MARKET',UNSUPPORTED_MARKET_TYPE:'UNSUPPORTED_MARKET_TYPE',ALLOWED_QUOTE:'ALLOWED_QUOTE',DISALLOWED_QUOTE:'DISALLOWED_QUOTE',SUFFICIENT_VOLUME:'SUFFICIENT_VOLUME',LOW_VOLUME:'LOW_VOLUME',MISSING_SNAPSHOT:'MISSING_SNAPSHOT',STALE_SNAPSHOT:'STALE_SNAPSHOT',EXCHANGE_STALE:'EXCHANGE_STALE',EXCHANGE_UNAVAILABLE:'EXCHANGE_UNAVAILABLE',SPREAD_ACCEPTABLE:'SPREAD_ACCEPTABLE',SPREAD_TOO_WIDE:'SPREAD_TOO_WIDE',MISSING_SPREAD:'MISSING_SPREAD'});
const activeStatus=market=>['TRADING','Trading','live'].includes(market.status);
const tierFor=(volume,policy)=>{if(!Number.isFinite(volume))return'EXCLUDED';if(volume>=policy.liquidityTiers.A)return'A';if(volume>=policy.liquidityTiers.B)return'B';if(volume>=policy.liquidityTiers.C)return'C';return'EXCLUDED'};
function evaluateEligibility(market,policy,now=Date.now()){
  const reasons=[],fail=code=>reasons.push(code),pass=code=>reasons.push(code);
  activeStatus(market)?pass(REASONS.ACTIVE_MARKET):fail(REASONS.INACTIVE_MARKET);
  market.marketType===policy.marketType?pass(REASONS.SPOT_MARKET):fail(REASONS.UNSUPPORTED_MARKET_TYPE);
  policy.allowedQuotes.includes(market.quoteAsset)?pass(REASONS.ALLOWED_QUOTE):fail(REASONS.DISALLOWED_QUOTE);
  const volume=Number(market.quoteVolume24h),hasSnapshot=Number.isFinite(volume)&&Number.isFinite(Number(market.snapshotTimestamp));
  if(!hasSnapshot)fail(REASONS.MISSING_SNAPSHOT);else if(now-Number(market.snapshotTimestamp)>policy.staleSnapshotTimeoutMs)fail(REASONS.STALE_SNAPSHOT);else if(volume<policy.minimumQuoteVolume24h)fail(REASONS.LOW_VOLUME);else pass(REASONS.SUFFICIENT_VOLUME);
  if(policy.maximumSpreadPct!==null){if(!Number.isFinite(Number(market.spread)))policy.missingSpreadPolicy==='exclude'&&fail(REASONS.MISSING_SPREAD);else Number(market.spread)>policy.maximumSpreadPct?fail(REASONS.SPREAD_TOO_WIDE):pass(REASONS.SPREAD_ACCEPTABLE)}
  const failures=new Set([REASONS.INACTIVE_MARKET,REASONS.UNSUPPORTED_MARKET_TYPE,REASONS.DISALLOWED_QUOTE,REASONS.MISSING_SNAPSHOT,REASONS.STALE_SNAPSHOT,REASONS.LOW_VOLUME,REASONS.MISSING_SPREAD,REASONS.SPREAD_TOO_WIDE]),eligible=!reasons.some(reason=>failures.has(reason)),liquidityTier=eligible?tierFor(volume,policy):'EXCLUDED';
  return{eligible:eligible&&liquidityTier!=='EXCLUDED',liquidityTier:eligible?liquidityTier:'EXCLUDED',reasons};
}
module.exports={REASONS,evaluateEligibility,tierFor};
