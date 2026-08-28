'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
test('workspace has one primary instrument header and no redundant selectors',()=>{assert.doesNotMatch(html,/id="pair-selector"|id="exchange-selector"/);assert.equal((html.match(/data-pair-label/g)||[]).length,1);assert.match(html,/class="primary-market-identity"/);assert.match(html,/id="favorite-button"/)});
test('chart legend is OHLC-only and sidebar is Watchlist-only',()=>{assert.doesNotMatch(html,/id="chart-title"/);assert.match(html,/id="ohlc-status"/);assert.doesNotMatch(html,/class="instrument-panel"|DAY'S RANGE|Key stats/);assert.doesNotMatch(html,/data-pulse-volume/)});
test('compact Watchlist filters and monthly timeframe remain',()=>{assert.match(html,/Watchlist filters"><button class="active" type="button">ALL<\/button><button type="button">FAV<\/button>/);assert.match(html,/data-interval="1M"/)});
