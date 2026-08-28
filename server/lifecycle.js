'use strict';

const STATES = Object.freeze(['STARTING', 'WARMING_UP', 'READY', 'DEGRADED', 'STOPPING', 'STOPPED']);

class ApplicationLifecycle {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.state = 'STARTING';
    this.reasonCodes = ['APPLICATION_STARTING'];
    this.transitionedAt = this.now();
    this.history = [{ state:this.state, reasonCodes:[...this.reasonCodes], transitionedAt:this.transitionedAt }];
  }
  transition(state, reasonCodes = []) {
    if (!STATES.includes(state)) throw new Error('Invalid application lifecycle state');
    if (this.state === 'STOPPED' && state !== 'STOPPED') return this.snapshot();
    this.state = state;
    this.reasonCodes = [...new Set(reasonCodes.filter(value => typeof value === 'string' && /^[A-Z0-9_]+$/.test(value)))];
    this.transitionedAt = this.now();
    this.history.push({ state:this.state, reasonCodes:[...this.reasonCodes], transitionedAt:this.transitionedAt });
    return this.snapshot();
  }
  snapshot() { return { state: this.state, reasonCodes: [...this.reasonCodes], transitionedAt: this.transitionedAt }; }
}

module.exports = { ApplicationLifecycle, STATES };
