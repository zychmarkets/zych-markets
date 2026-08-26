(function (global) {
  'use strict';
  const SOUND_KEYS = Object.freeze({ sound: 'zych.alerts.sound', enabled: 'zych.alerts.soundEnabled', volume: 'zych.alerts.volume' });
  const LEGACY_ENABLED_KEY = 'zych.alert-sound.v1', DEFAULT_SOUND = 'zych-pulse', DEFAULT_VOLUME = 0.65;
  const SOUND_OPTIONS = Object.freeze([{ id: 'zych-pulse', label: 'ZYCH Pulse' }, { id: 'soft-bell', label: 'Soft Bell' }, { id: 'terminal', label: 'Terminal' }, { id: 'urgent', label: 'Urgent' }]);
  const VALID_SOUNDS = new Set(SOUND_OPTIONS.map(option => option.id));
  const safeRead = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const safeWrite = (key, value) => { try { localStorage.setItem(key, String(value)); } catch {} };
  const clampVolume = value => Math.min(1, Math.max(0, Number(value) || 0));

  class AlertSoundManager {
    constructor({ onState = () => {} } = {}) {
      this.context = null; this.soundId = this.loadSound(); this.enabled = this.loadEnabled(); this.volume = this.loadVolume(); this.unlocked = false; this.playCount = 0; this.onState = onState;
      this.unlock = this.unlock.bind(this); document.addEventListener('pointerdown', this.unlock, { passive: true }); document.addEventListener('keydown', this.unlock);
    }
    loadSound() { const value = safeRead(SOUND_KEYS.sound); return VALID_SOUNDS.has(value) ? value : DEFAULT_SOUND; }
    loadEnabled() { const value = safeRead(SOUND_KEYS.enabled); if (value !== null) return value === 'true'; const legacy = safeRead(LEGACY_ENABLED_KEY); return legacy === null ? true : legacy === 'on'; }
    loadVolume() { const value = Number(safeRead(SOUND_KEYS.volume)); return Number.isFinite(value) && value > 0 && value <= 1 ? value : DEFAULT_VOLUME; }
    setSound(soundId) { if (!VALID_SOUNDS.has(soundId)) return false; this.soundId = soundId; safeWrite(SOUND_KEYS.sound, soundId); this.emitState(); return true; }
    setEnabled(enabled) { this.enabled = Boolean(enabled); safeWrite(SOUND_KEYS.enabled, this.enabled); this.emitState(); }
    setVolume(value) { this.volume = clampVolume(value); safeWrite(SOUND_KEYS.volume, this.volume); this.emitState(); }
    state() { return { soundId: this.soundId, enabled: this.enabled, volume: this.volume, unlocked: this.unlocked, playCount: this.playCount }; }
    emitState() { this.onState(this.state()); }
    ensureContext() { if (!this.context) { const AudioContextClass = global.AudioContext || global.webkitAudioContext; if (!AudioContextClass) return null; this.context = new AudioContextClass({ latencyHint: 'interactive' }); } return this.context; }
    async unlock() { try { const context = this.ensureContext(); if (!context) return false; if (context.state === 'suspended') await context.resume(); this.unlocked = context.state === 'running'; this.emitState(); return this.unlocked; } catch { return false; } }
    envelope(context, destination, start, attack, peak, release) { const gain = context.createGain(); gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), start + attack); gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + release); gain.connect(destination); return gain; }
    tone(context, destination, { start, duration, frequency, endFrequency = frequency, type = 'sine', gain = 1, attack = 0.012 }) { const oscillator = context.createOscillator(), envelope = this.envelope(context, destination, start, attack, gain, Math.max(0.02, duration - attack)); oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, start); if (endFrequency !== frequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration); oscillator.connect(envelope); oscillator.start(start); oscillator.stop(start + duration + 0.025); }
    render(soundId, context, output, now) {
      if (soundId === 'soft-bell') { this.tone(context, output, { start: now, duration: 0.82, frequency: 659.25, gain: 0.72, attack: 0.018 }); this.tone(context, output, { start: now + 0.012, duration: 0.66, frequency: 1318.5, gain: 0.20 }); this.tone(context, output, { start: now + 0.018, duration: 0.54, frequency: 1977.75, gain: 0.07 }); return; }
      if (soundId === 'terminal') { this.tone(context, output, { start: now, duration: 0.16, frequency: 392, endFrequency: 466.16, type: 'triangle', gain: 0.56, attack: 0.008 }); this.tone(context, output, { start: now + 0.15, duration: 0.24, frequency: 587.33, type: 'triangle', gain: 0.48, attack: 0.008 }); return; }
      if (soundId === 'urgent') { [0, 0.18, 0.36].forEach((offset, index) => this.tone(context, output, { start: now + offset, duration: 0.15, frequency: index === 2 ? 783.99 : 698.46, endFrequency: index === 2 ? 880 : 783.99, type: 'triangle', gain: index === 2 ? 0.70 : 0.58, attack: 0.009 })); return; }
      this.tone(context, output, { start: now, duration: 0.38, frequency: 523.25, endFrequency: 659.25, gain: 0.70, attack: 0.018 }); this.tone(context, output, { start: now + 0.22, duration: 0.42, frequency: 783.99, endFrequency: 987.77, gain: 0.52, attack: 0.016 }); this.tone(context, output, { start: now + 0.23, duration: 0.30, frequency: 1567.98, gain: 0.08 });
    }
    async play(soundId = this.soundId, { force = false } = {}) {
      if (!VALID_SOUNDS.has(soundId)) soundId = this.soundId; if (!force && !this.enabled) return false;
      try { const context = this.ensureContext(); if (!context) return false; if (context.state === 'suspended') await context.resume(); if (context.state !== 'running') { this.unlocked = false; this.emitState(); return false; } this.unlocked = true; const now = context.currentTime + 0.008, master = context.createGain(); master.gain.setValueAtTime(this.volume, now); master.connect(context.destination); this.render(soundId, context, master, now); this.playCount += 1; this.emitState(); return true; } catch { return false; }
    }
    preview(soundId = this.soundId) { return this.play(soundId, { force: true }); }
  }
  global.ZychNotifications = { ...(global.ZychNotifications || {}), AlertSoundManager, AlertSound: AlertSoundManager, SOUND_KEYS, SOUND_OPTIONS, DEFAULT_SOUND, DEFAULT_VOLUME };
})(window);
