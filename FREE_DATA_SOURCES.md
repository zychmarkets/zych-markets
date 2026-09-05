# Free data integration — 2026-09-05

Goal: populate the approved interface with real data, starting with free sources. Keep the existing panels. This first implementation covers three metrics; it does not complete every panel.

## Implemented in this branch

| Panel | Data and scope | Refresh and failure behavior |
| --- | --- | --- |
| Total Crypto Cap | Alternative.me global USD capitalization; the provider's asset count is displayed alongside the value. This is the provider's universe, not a guarantee of complete crypto coverage. | Five-minute server cache; stale after 30 minutes of source age or a failed refresh. |
| BTC Dominance and Dominance ring | BTC market cap divided by the same provider's total cap, multiplied by 100. Both timestamps must be within ten minutes, and BTC cap cannot exceed total cap. | Same cache; oldest component timestamp determines freshness. A failed component makes the result stale or unavailable. |
| Fear & Greed in Markets pulse, context strip and Radar | Alternative.me Bitcoin sentiment index, 0–100, daily. Source classification is displayed only if recognized. | Source timestamp shown; stale after 48 hours or a failed refresh. Attribution sits beside every display. |

The provider's `bitcoin_percentage_of_market_cap` is deliberately ignored: documentation shows percentages while the inspected live response returned a fraction. The displayed dominance uses an explicit capitalization ratio instead.

Source references: [Crypto API documentation and commercial-use FAQ](https://alternative.me/crypto/api/), [Fear & Greed methodology and attribution rules](https://alternative.me/crypto/fear-and-greed-index/). Both are available without a key. On inspection, the global response reported 178 assets; coverage is read dynamically, never hardcoded into the UI.

## Remaining panels — free-first investigation

| Panel | Next source or method to verify | What is still required |
| --- | --- | --- |
| Broader global capitalization / BTC dominance | CoinMarketCap Basic | Free account key and endpoint entitlement check; use one provider consistently for numerator and denominator. |
| Stablecoin Cap | Provider category aggregate in USD | Verify free endpoint access, category membership and commercial display conditions. Do not add circulating amounts denominated in different currencies. |
| DeFi TVL | DefiLlama is a technical candidate | Its published terms restrict republication/commercial exploitation without permission; free API availability alone is insufficient. No integration added. |
| Altseason Index | Published index or a defined 90-day relative-performance calculation | Agree on universe, exclusions, historical coverage and missing-data rules. Do not substitute Fear & Greed. |
| Market Mode | Defined ZYCH market-state calculation | Specify inputs, thresholds and partial-coverage rules before labeling a market bullish/bearish. |
| Market Overview | Historical series for the stated exchange/market scope | Confirm what the chart measures and obtain matching history. A current total must not be turned into invented history. |
| Sector Performance | Category membership plus comparable returns | Free data rights, weighting method and coverage per sector. |
| Global BTC Long/Short | Derivatives-provider aggregate | Define accounts versus positions, venues and weighting. A single-exchange ratio must not be labeled global. |
| Funding Rate | Public derivatives exchange endpoint | Verify supported contract, funding interval and data-use terms. Keep derivatives distinct from the selected Spot market. |
| ETH Gas | Ethereum JSON-RPC estimate | Verify a suitable public RPC's production conditions and units; display Gwei, not a fabricated transaction cost. |
| S&P 500 / Nasdaq / Gold / DXY | Licensed public/free delayed feed if available | Exact instrument, redistribution rights, delay and market session. No live feed promised yet. |
| Radar 7D Trend / Top-20 Heatmap | Defined asset universe and historical/volume data | Match the Radar specification; do not silently reuse a differently scoped exchange ranking. |
| Watchlist sparklines | Existing candle adapters where supported | Bounded per-symbol history, caching and freshness; separate implementation. |
| Chart order book / trades | Verified exchange feeds | Existing capability contracts and per-exchange subscriptions; separate implementation. |

CoinMarketCap currently advertises a free Basic plan with commercial use, but credentials and specific endpoint access remain unverified: [official API page](https://coinmarketcap.com/api/), [keyless evaluation versus keyed integration](https://coinmarketcap.com/api/resources/coinmarketcap-keyless-public-api-guide-developers-guide/). Keyless evaluation is not used as an undocumented production dependency.

DefiLlama: [published terms](https://defillama.com/terms). This is an unresolved source-permission question, not a claim that TVL cannot be implemented.

## Implementation and verification

- `GET /api/market-context/free` accepts no query parameters. Fixed server-side URLs, redirects disabled, seven-second timeout and 64 KiB response limit. Browser requests stay on the current origin; CSP is unchanged.
- Requests coalesce across clients. Successful source reads cache for five minutes; failures retry after 30 seconds. Browser refreshes once per minute; exchange switching does not refetch global data.
- Provider timestamps, USD units, finite values, coverage and BTC identity are checked. Zero sentiment is valid. A failed refresh retains previous values as stale without changing their source time. No stored alerts, watchlists, keys or subscriptions are modified.
- `npm test`: 798 tests passed plus five preliminary suites; `git diff --check` passed. Twelve new tests cover parsing, unit ambiguity, partial failure, cache/retry, stale/regressed timestamps, timeouts, oversized responses, attribution rendering, client lifecycle and the HTTP route.
- Public API responses were inspected through web retrieval. Direct outbound requests from the local execution environment did not complete successfully; real end-to-end delivery from the app is not verified here. Visual/browser verification on the owner's review server is still required.

## Review on the owner's computer

Use the separate review worktree/server, retaining its local configuration and data. Do not merge to main until reviewed.

1. Fetch `feat/free-market-context` into a clean review worktree. Run `npm test` and `git diff --check`.
2. Start with the existing review configuration on port 4188. Verify `/api/market-context/free` and inspect each metric's status, source timestamp and coverage.
3. In Markets, check capitalization, BTC percentage, dominance ring and sentiment. Confirm neighboring panels retain their positions; check 1366×768 and the Russian locale for clipping.
4. Switch Binance → Kraken: global context should keep the same scope and values while exchange data changes separately.
5. Check the Fear & Greed copy in Radar and the Markets strip. Each must display the source link and daily Bitcoin scope.
6. Check that unavailable or stale data is labeled explicitly. Keep alert/watchlist data intact. Report any console errors before merging.
