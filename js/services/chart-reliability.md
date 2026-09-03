# Chart reliability (Stage 12B)

`chart-reliability.js` collects browser Chart observations into the Stage 12A
`reliability-contract.js` schema and invokes `reliability-reducer.js`. It does
not implement another health reducer. Adapter status hints cannot establish
LIVE. Alerts, Radar, snapshots and their server transports do not use this
collector.

Every replacement socket receives a new connection ID and generation, empty
subscription/data evidence, and the runtime's accumulated reconnect count.
The adapter close guard and the application's selected-socket/generation guard
both apply. Asynchronous decompression and repair retain their original receipt
times and cannot publish after replacement. A one-second Chart timer reevaluates
freshness even when messages stop.

| Feed | Required confirmation | Receipt freshness budget | Source event time |
| --- | --- | --- | --- |
| Binance raw kline (optional exact combined envelope) | Not applicable | 15 seconds | `E` |
| Bybit exact kline topic | Matching request ID ACK | 90 seconds | `ts` |
| OKX exact candle channel and instrument | Exact channel/instrument ACK | 30 seconds | Unknown (`null`) |
| BingX exact Spot kline | Matching request ID ACK | 90 seconds | `data.E`, when supplied |
| Coinbase exact market_trades updates | market_trades and heartbeats confirmed | 2 × timeframe, minimum 2 minutes, maximum 15 minutes | Trade `time` |
| Kraken exact OHLC updates | Exact ACK, REST readiness and reconciliation | 2 × timeframe, minimum 2 minutes, maximum 15 minutes | Unknown (`null`) |

These are conservative Chart freshness budgets, not exchange availability SLAs.
Binance and OKX are frequent candle streams; Bybit documents 1–60 second pushes.
BingX supplies updates without a guaranteed cadence, so its 90-second budget
only limits how long the last observation is called fresh. Candle qualification
also checks the selected interval and rejects historical/future candle windows.
Coinbase and Kraken are activity-driven: no trades can yield WAITING_FOR_DATA
before any qualifying update or STALE after the applicable budget, while the
connection remains OPEN. Heartbeats never advance market-data timestamps.
Existing Coinbase/Kraken transport watchdogs and bounded REST repairs remain.

BingX Spot wire intervals were verified against the real configured endpoint:
`1h → 60min`, `4h → 4hour`, `1d → 1day`, `1w → 1week`, `1M → 1mon`.
The endpoint returned correlated ACKs and matching candle messages for these
names. It rejected the old `1h` wire name with code 100400, despite the separate
official example repository listing that name. This correction is Chart-local.

Source age uses genuine event timestamps when provided. Missing timestamps stay
null. OHLC interval boundaries (including Kraken's deprecated `timestamp`) are
not exchange event time. Receipt and processing timestamps remain independent,
including delayed BingX decompression and queued REST/WS overlap.

REST history/cache never supplies first live data. `historyEvidence` on the Chart
element records cache usage and its original REST storage time; LRU hits do not
refresh that timestamp. Cache storage has no new freshness guarantee or TTL.
Reconciliation can verify continuity but cannot refresh market-data age.

The existing Chart status slots show reducer states, with FAILED rendered as
OFFLINE, UNKNOWN as WAITING FOR DATA, and DEGRADED as RECONCILING. Unsupported
intervals and unavailable markets are capability results; Kraken history is
LIMITED even when the live feed is LIVE. `Last data` displays whole receipt-age
seconds, or an em dash when unavailable. Chart-only DOM diagnostics expose the
canonical result and the most recent 30 state/generation transitions.

Protocol references checked during implementation:

- [Binance Spot streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)
- [Bybit kline](https://bybit-exchange.github.io/docs/v5/websocket/public/kline)
- [OKX API guide](https://www.okx.com/docs-v5)
- [BingX Spot K-line](https://bingx-api.github.io/docs-v3/#/en/Spot/Websocket%20Market%20Data/K-line%20Streamst)
- [Coinbase Advanced Trade WebSocket](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints)
- [Kraken OHLC v2](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ohlc)
