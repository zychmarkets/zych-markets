# Reliability contract v1 — Stage 12A

Foundation only. No Chart transitions, alert evaluation, Radar readiness,
snapshot rendering or persistent owner records are migrated in this stage.

## Ownership and public API

`reliability-contract.js` and `reliability-reducer.js` are pure CommonJS/browser
modules, following the existing services convention. Browser globals are
`ZychReliabilityContract` and `ZychReliability`; production HTML deliberately
does not load them yet. No timers, network, storage, mutable manager or bus.

- `evidence(input)` creates a whitelisted, serializable evidence record.
- `capability(input)` accepts SUPPORTED, LIMITED, UNSUPPORTED; absent/invalid
  capability is UNKNOWN (lack of knowledge, not a fourth product capability).
- `selectGeneration(evidence, current)` fences a connection's observations.
- `domainPolicy(domain, overrides)` prepares policy, with no stale thresholds.
- `reduceFeed(evidence, {policy, now, current})` derives one topic's result.
- `diagnostics({domain, records, policy, now, instanceId, detailLimit})` reduces
  a complete expected-topic manifest and returns a bounded public DTO.
- `withReliability(legacy, dto)` adds the DTO without translating/replacing
  any legacy status field. It does not mutate either input.

Capability, connection, subscription, data, heartbeat, continuity, processing,
persistence and delivery stay distinct. A result is an observation derived
for an explicit clock value, not a mutable health authority.

## Timestamp semantics

All times are nullable integer UTC epoch milliseconds. Invalid values and
numeric strings become null, never a substitute clock value. Adapters must
explicitly parse/convert source timestamps before normalization.

| Field | Evidence required |
| --- | --- |
| sourceTimestamp | Actual source/exchange event time only |
| lastReceiptAt | This process received validated data |
| processingTimestamp | Successful normalization/evaluation completion |
| lastMarketDataAt | Validated market-data receipt, never a control frame |
| lastPriceAt | Validated usable price receipt |
| lastCandleAt | Validated qualifying candle-update receipt |
| lastSnapshotAt | Successful upstream acquisition/verification |
| upstreamReceiptAt | Original upstream/proxy process receipt, if known |
| cacheStoredAt | Cache storage time, not freshness evidence |
| lastHeartbeatAt | Validated received heartbeat |
| lastAckAt | Correlated successful protocol ACK |
| firstDataAt | First validated usable data in this generation |
| requestedAt | Subscription request sent in this generation |
| openedAt / closedAt | Connection lifecycle observations |
| lastReconnectAt | New recovery/connection generation start |
| lastVerifiedAt | Successful continuity verification |
| lastSuccessAt | Successful processing/persistence/delivery stage observation |
| lastErrorAt | Structured error observation |

The normalizer cannot prove a caller's timestamp provenance. Producers must
never put candle open/close boundaries, cache-read time or arbitrary local
`now()` into sourceTimestamp. Legacy mixed-semantics timestamps are NOT
adapted automatically. Future producers may add distinct candle boundary
fields through a versioned extension.

## Policy, freshness and reduction

Policies can be selected by domain/exchange/channel/timeframe and carry cadence
metadata. `diagnostics.policy` can be an identity-to-policy function, outside
the serialized DTO. Production thresholds are deferred to 12B–12D.

Default stream policies require current generation, open connection and
subscription proof. Alerts additionally require processing and persistence;
Radar requires continuity and processing. Notifications require delivery.
Snapshot/backend/notification observations do not require a socket generation
by default; an adapter can require one for a connection-scoped use case.

`dataField` selects a validated receipt field: lastReceiptAt, lastMarketDataAt,
lastPriceAt, lastCandleAt or lastSnapshotAt. A heartbeat, source timestamp,
processing time or cache storage time cannot serve as receipt freshness.

`maxReceiptAgeMs` is required to establish FRESH. `maxSourceAgeMs` additionally
checks source age when present. `requireSourceTimestamp` requires source time
and an explicit source-age budget. Missing policy/provenance is UNKNOWN.
An age equal to its budget remains FRESH; greater is STALE. Future timestamps
cannot establish freshness. No final clock-skew allowance is invented here.
FRESH with optional missing source time means receipt-policy freshness only;
sourceAgeMs remains null, not zero. Quiet trade feeds need activity-aware
policy/reconciliation in later stages, not a universal no-trades timeout.

Priority: unsupported capability; invalid epoch/unknown capability; domain
mismatch; connection recovery/failure/closure/connecting; subscription
failure/pending; stale data; missing data/freshness; required downstream gates;
then LIVE. A recent nonfatal error remains evidence without independently
overriding a recovered connection. FAILED requires explicit failure evidence.

## Subscriptions and aggregation

Each `records` entry is `{evidence, current}` for one expected topic. Include
missing topics as empty evidence records with their identities/capabilities;
passing only healthy topics cannot describe exchange-wide coverage. `current`
is the authoritative `{connectionId, generation}` for that topic's connection,
not a maximum generation inferred across unrelated sockets.

Mismatch/missing epoch removes connection, ACK, data, heartbeat, error and
downstream-stage evidence; static identity/capability survive. Old ACKs cannot
establish a replacement socket's health. Producers must not relabel old
observations with a new epoch. For direct Binance Chart streams use explicit
`not-applicable`; do not manufacture an ACK timestamp.

Data-before-ACK remains data evidence while ACK remains pending/unknown.
`ackTimeoutMs` derives failure without mutating the observed acknowledgement.
Negative ACK stays rejected. A single topic's data or ACK affects only itself.

Counts: requested (request timestamp present), acknowledged (explicit ACK and
nonfuture ACK timestamp), failed (rejected/timed out), active (fresh topic,
satisfied subscription and required connection/epoch), stale (requested
topic with stale data). Active is NOT complete downstream readiness; `live`
counts only fully reduced LIVE results. Direct-stream topics need requestedAt
to count as requested, but never count as acknowledged without a real ACK.

Uniform applicable states retain that state; mixed states produce PARTIAL.
UNSUPPORTED records are reported separately and excluded from runtime
denominators. An empty manifest is UNKNOWN, not healthy. Duplicate exact
topic/connection records are rejected to avoid inflated coverage. Different
intervals and independent sockets retain separate evidence.

## Diagnostics and migration

DTO: schemaVersion, generatedAt, nullable instanceId, domain, summary, counts,
reasons, details, omittedDetails. Details default to 50, hard cap 200; counts
always cover the entire provided manifest. Public details strip free-form
error/disconnect messages because upstream errors can contain endpoints or
owner data. Machine codes and timestamps remain. No raw legacy diagnostics,
owner alerts, subscription endpoints, sockets or controllers are copied.

`server/product-capabilities.js` adds `normalizedProductCapabilities()` while
keeping `productCapabilities()` unchanged. Canonical Radar exclusions use
UNSUPPORTED / EXACT_LIQUIDITY_UNAVAILABLE. Kraken's history cap is LIMITED,
not an outage. Interval capabilities reflect the existing adapter maps,
including missing 30m support, without changing legacy UI behavior.

`/api/health.reliability` is additive and deliberately UNKNOWN while evidence
is not instrumented. It includes independent server-domain diagnostics and
canonical capability facts. It does not interpret legacy `live` as proof.
The instance ID belongs to the HTTP server instance and is stable across
requests, new on restart. Browser Chart health is not claimed by the server.
Existing health fields, Radar endpoints and /health/ready are untouched.

Later parts supply trustworthy producer evidence and replace legacy reducers
one domain at a time. This contract must not become a second health service.
