'use strict';
// Detectors are Level-1 detection only: normalized input -> CandidateEvent[].
// They must not score, deduplicate, persist, notify, render, or consume raw exchange payloads.
const isDetector=value=>Boolean(value&&typeof value.id==='string'&&typeof value.version==='string'&&typeof value.evaluate==='function');
module.exports={isDetector};
