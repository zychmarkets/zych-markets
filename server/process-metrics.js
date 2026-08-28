'use strict';
const os = require('node:os');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const finite = value => Number.isFinite(value) ? value : 0;
const milliseconds = nanoseconds => finite(nanoseconds / 1e6);

class ProcessMetrics {
  constructor({ now = Date.now, histogram = null } = {}) {
    this.now = now;
    this.processStartedAt = this.now();
    this.previousCpu = process.cpuUsage();
    this.previousSampleAt = this.processStartedAt;
    this.histogram = histogram || monitorEventLoopDelay({ resolution: 20 });
    this.running = false;
  }
  start() { if (!this.running) { this.histogram.enable(); this.running = true; } return this; }
  sample() {
    const timestamp = this.now(), memory = process.memoryUsage(), cpu = process.cpuUsage(this.previousCpu), elapsedMicros = Math.max(1, (timestamp - this.previousSampleAt) * 1000);
    this.previousCpu = process.cpuUsage(); this.previousSampleAt = timestamp;
    const eventLoop = { unit: 'milliseconds', mean: milliseconds(this.histogram.mean), max: milliseconds(this.histogram.max), p50: milliseconds(this.histogram.percentile(50)), p95: milliseconds(this.histogram.percentile(95)), p99: milliseconds(this.histogram.percentile(99)) };
    this.histogram.reset();
    return { processStartedAt: this.processStartedAt, uptimeSeconds: Math.max(0, (timestamp - this.processStartedAt) / 1000), pid: process.pid, memoryBytes: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers || 0 }, cpu: { userMicros: cpu.user, systemMicros: cpu.system, utilizationPct: finite((cpu.user + cpu.system) / elapsedMicros * 100) }, hostLoadAverage: os.loadavg().map(finite), eventLoop };
  }
  stop() { if (this.running) this.histogram.disable(); this.running = false; }
}
module.exports = { ProcessMetrics };
