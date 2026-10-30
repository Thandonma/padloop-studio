#!/usr/bin/env python3
"""
Renders the original worship-style starter pads that ship with PadLoop Studio.

Everything here is synthesised from scratch (no samples, no third-party audio),
so the results are original works you are free to use, change and redistribute.

Each pad is a sustained root + fifth + octave drone in C, which sits comfortably
under both major and minor chords. The app pitch-shifts it to whichever key you
play, so one file covers all twelve keys.

Loops are seamless by construction: every oscillator frequency and every LFO
rate is snapped to a whole number of cycles per loop, and the reverb is applied
as a circular convolution so its tail wraps back into the start of the loop.

    python3 tools/make-pads.py            # writes public/pads/*.wav
    python3 tools/make-pads.py --check    # also prints quality metrics
"""

from __future__ import annotations

import argparse
import json
import math
import os
import wave

import numpy as np

SR = 32_000          # plenty for pads, and keeps the download small
LOOP = 12.0          # seconds
N = int(SR * LOOP)
T = np.arange(N, dtype=np.float32) / SR
RNG = np.random.default_rng(20_260_916)

C3 = 130.8128        # the root everything is built on


# ---------------------------------------------------------------------------
# Helpers. Snapping to the loop grid is what makes the loops seamless.
# ---------------------------------------------------------------------------

def snap(freq: float) -> float:
    """Nearest frequency with a whole number of cycles per loop."""
    return max(1, round(freq * LOOP)) / LOOP


def lfo(rate_hz: float, phase: float = 0.0) -> np.ndarray:
    """Slow modulator, also snapped so it repeats exactly once per loop."""
    cycles = max(1, round(rate_hz * LOOP))
    return np.sin(2 * np.pi * (cycles / LOOP) * T + phase, dtype=np.float32)


def cents(freq: float, c: float) -> float:
    return freq * (2 ** (c / 1200))


def lowpass_gain(freq: float, cutoff: np.ndarray, order: int = 2) -> np.ndarray:
    """Amplitude response of a gentle low-pass filter at one frequency."""
    return 1.0 / np.sqrt(1.0 + (freq / cutoff) ** (2 * order))


def formant_gain(freq: float, formants) -> float:
    """Sum of resonant peaks, used for the choir's vowel colour."""
    g = 0.02
    for centre, width, level in formants:
        g += level / (1.0 + ((freq - centre) / width) ** 2)
    return g


# ---------------------------------------------------------------------------
# Oscillator bank
# ---------------------------------------------------------------------------

def add_oscillator(
    left: np.ndarray,
    right: np.ndarray,
    freq: float,
    *,
    amp: float,
    pan: float,
    harmonics: int,
    harmonic_rolloff: float,
    cutoff: np.ndarray,
    odd_only: bool = False,
    formants=None,
    swell: np.ndarray | None = None,
) -> None:
    """Adds one band-limited oscillator built from its harmonic series."""
    freq = snap(freq)
    gl = amp * math.sqrt(0.5 * (1.0 - pan))
    gr = amp * math.sqrt(0.5 * (1.0 + pan))
    for h in range(1, harmonics + 1):
        if odd_only and h % 2 == 0:
            continue
        f = freq * h
        if f > 0.45 * SR:
            break
        level = 1.0 / (h ** harmonic_rolloff)
        if formants:
            level *= formant_gain(f, formants)
        if level < 1e-4:
            continue
        # Each harmonic breathes at its own slow rate, which is what stops a
        # synthetic pad from sounding static.
        shimmer = 1.0 + 0.22 * lfo(0.03 + 0.021 * h, RNG.uniform(0, 2 * math.pi))
        env = (level * shimmer * lowpass_gain(f, cutoff)).astype(np.float32)
        if swell is not None:
            env = env * swell
        wave_ = np.sin(2 * np.pi * snap(f) * T + RNG.uniform(0, 2 * math.pi), dtype=np.float32)
        left += gl * env * wave_
        right += gr * env * wave_


# ---------------------------------------------------------------------------
# Reverb: synthesised impulse response, applied circularly
# ---------------------------------------------------------------------------

def reverb_ir(seconds: float, brightness: float) -> np.ndarray:
    n = int(SR * seconds)
    ir = RNG.standard_normal((2, n)).astype(np.float32)
    decay = np.exp(-np.arange(n, dtype=np.float32) * (6.0 / n))
    # A short build-up reads as a room rather than a gated burst.
    attack = np.clip(np.arange(n, dtype=np.float32) / (SR * 0.02), 0, 1)
    ir *= decay * attack
    # Darken the tail: high frequencies die away first in a real space.
    spec = np.fft.rfft(ir, axis=1)
    freqs = np.fft.rfftfreq(n, 1 / SR)
    spec *= 1.0 / (1.0 + (freqs / (brightness * 1000)) ** 2)
    ir = np.fft.irfft(spec, n, axis=1).astype(np.float32)
    ir /= np.max(np.abs(ir)) + 1e-9
    return ir


def apply_reverb(stereo: np.ndarray, seconds: float, brightness: float, wet: float) -> np.ndarray:
    ir = reverb_ir(seconds, brightness)
    padded = np.zeros_like(stereo)
    n = min(ir.shape[1], padded.shape[1])
    padded[:, :n] = ir[:, :n]
    # Circular convolution, so the reverb tail wraps into the loop start.
    wetsig = np.fft.irfft(np.fft.rfft(stereo, axis=1) * np.fft.rfft(padded, axis=1), N, axis=1)
    wetsig = wetsig.astype(np.float32)
    wetsig /= np.max(np.abs(wetsig)) + 1e-9
    dry = stereo / (np.max(np.abs(stereo)) + 1e-9)
    return ((1 - wet) * dry + wet * wetsig).astype(np.float32)


# ---------------------------------------------------------------------------
# The voices
# ---------------------------------------------------------------------------

def warm_pad() -> np.ndarray:
    """Classic analogue warmth: detuned saws under a slow filter sweep."""
    left, right = np.zeros(N, np.float32), np.zeros(N, np.float32)
    cutoff = 1500 * (2 ** (0.9 * lfo(0.035)))
    notes = [(C3 / 2, 0.55), (C3, 1.0), (C3 * 1.5, 0.75), (C3 * 2, 0.5)]
    spread = [(-9, -0.75), (-3, 0.35), (4, -0.3), (10, 0.8)]
    for freq, level in notes:
        for detune, pan in spread:
            add_oscillator(
                left, right, cents(freq, detune),
                amp=level * 0.25, pan=pan, harmonics=22, harmonic_rolloff=1.0, cutoff=cutoff,
            )
    return apply_reverb(np.stack([left, right]), 3.0, 2.2, 0.45)


def air_pad() -> np.ndarray:
    """Soft and airy, with an octave shimmer that swells in and out."""
    left, right = np.zeros(N, np.float32), np.zeros(N, np.float32)
    cutoff = 6500 * (2 ** (0.5 * lfo(0.025, 1.1)))
    notes = [(C3, 0.5), (C3 * 1.5, 0.5), (C3 * 2, 0.75), (C3 * 3, 0.6), (C3 * 4, 0.5), (C3 * 6, 0.3)]
    for i, (freq, level) in enumerate(notes):
        swell = (0.72 + 0.28 * lfo(0.02 + 0.013 * i, i * 1.3)).astype(np.float32)
        for detune, pan in [(-5, -0.6), (5, 0.6)]:
            add_oscillator(
                left, right, cents(freq, detune),
                amp=level * 0.3, pan=pan, harmonics=9, harmonic_rolloff=1.3,
                cutoff=cutoff, odd_only=True, swell=swell,
            )
    return apply_reverb(np.stack([left, right]), 4.5, 3.0, 0.6)


def strings_pad() -> np.ndarray:
    """An ensemble: many lightly detuned voices with a slow vibrato."""
    left, right = np.zeros(N, np.float32), np.zeros(N, np.float32)
    cutoff = 2600 * (2 ** (0.7 * lfo(0.047, 0.4)))
    notes = [(C3, 1.0), (C3 * 1.5, 0.8), (C3 * 2, 0.65), (C3 * 3, 0.3)]
    spread = [(-14, -0.9), (-7, -0.4), (-2, 0.1), (3, 0.5), (8, 0.75), (14, 0.95)]
    for freq, level in notes:
        for detune, pan in spread:
            add_oscillator(
                left, right, cents(freq, detune),
                amp=level * 0.17, pan=pan, harmonics=18, harmonic_rolloff=1.15, cutoff=cutoff,
            )
    return apply_reverb(np.stack([left, right]), 3.4, 2.6, 0.5)


def choir_pad() -> np.ndarray:
    """A breathy 'ahh': harmonics shaped by vowel formants."""
    left, right = np.zeros(N, np.float32), np.zeros(N, np.float32)
    cutoff = 2400 * (2 ** (0.4 * lfo(0.03, 2.2)))
    vowel = [(700, 110, 1.0), (1100, 130, 0.6), (2600, 200, 0.12), (3500, 260, 0.05)]
    notes = [(C3, 1.0), (C3 * 1.5, 0.8), (C3 * 2, 0.6)]
    spread = [(-11, -0.8), (-4, -0.2), (4, 0.3), (11, 0.85)]
    for freq, level in notes:
        for detune, pan in spread:
            add_oscillator(
                left, right, cents(freq, detune),
                amp=level * 0.4, pan=pan, harmonics=30, harmonic_rolloff=0.9,
                cutoff=cutoff, formants=vowel,
            )
    # A little filtered breath on top.
    breath = RNG.standard_normal((2, N)).astype(np.float32)
    spec = np.fft.rfft(breath, axis=1)
    freqs = np.fft.rfftfreq(N, 1 / SR)
    spec *= np.exp(-(((freqs - 2200) / 1400) ** 2)) * (0.55 + 0.45 * np.cos(freqs / 400))
    breath = np.fft.irfft(spec, N, axis=1).astype(np.float32)
    breath /= np.max(np.abs(breath)) + 1e-9
    stereo = np.stack([left, right])
    stereo = stereo / (np.max(np.abs(stereo)) + 1e-9) + 0.035 * breath
    return apply_reverb(stereo, 4.0, 2.4, 0.55)


VOICES = [
    {
        "id": "warm",
        "name": "Warm Pad",
        "description": "Round analogue warmth. The safe one to start with.",
        "render": warm_pad,
        "tilt": -1.5,
    },
    {
        "id": "air",
        "name": "Air",
        "description": "Soft and spacious, with a gentle octave shimmer.",
        "render": air_pad,
        "tilt": 3.5,
    },
    {
        "id": "strings",
        "name": "Strings",
        "description": "An ensemble swell that sits under vocals.",
        "render": strings_pad,
        "tilt": 1.0,
    },
    {
        "id": "choir",
        "name": "Choir",
        "description": "Breathy voices humming an open 'ahh'.",
        "render": choir_pad,
        "tilt": -0.5,
    },
]


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def tilt_spectrum(stereo: np.ndarray, db_per_octave: float) -> np.ndarray:
    """Tilts the whole spectrum around 500 Hz: positive is brighter, negative warmer."""
    if not db_per_octave:
        return stereo
    spec = np.fft.rfft(stereo, axis=1)
    freqs = np.fft.rfftfreq(N, 1 / SR)
    octaves = np.log2(np.maximum(freqs, 20.0) / 500.0)
    spec *= 10 ** (db_per_octave * octaves / 20)
    return np.fft.irfft(spec, N, axis=1).astype(np.float32)


TARGET_RMS_DBFS = -15.0
PEAK_CEILING = 0.78


def finish(stereo: np.ndarray, tilt: float = 0.0) -> np.ndarray:
    """Shape the tone, soft-saturate, match loudness across voices, cap the peak."""
    stereo = tilt_spectrum(stereo, tilt)
    stereo = np.tanh(stereo * 1.15).astype(np.float32)
    stereo = stereo - stereo.mean(axis=1, keepdims=True)  # no DC offset
    rms = float(np.sqrt(np.mean(stereo.astype(np.float64) ** 2))) + 1e-9
    stereo = (stereo * (10 ** (TARGET_RMS_DBFS / 20) / rms)).astype(np.float32)
    peak = float(np.max(np.abs(stereo)))
    if peak > PEAK_CEILING:  # gentle limiting, only if needed
        stereo = np.tanh(stereo * (PEAK_CEILING / peak) * 1.1).astype(np.float32)
        stereo = (stereo * (PEAK_CEILING / (float(np.max(np.abs(stereo))) + 1e-9))).astype(np.float32)
    return stereo


def write_wav(path: str, stereo: np.ndarray) -> None:
    data = np.clip(stereo.T, -1.0, 1.0)
    pcm = (data * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def metrics(stereo: np.ndarray) -> dict:
    mono = stereo.mean(axis=0)
    spec = np.abs(np.fft.rfft(mono))
    freqs = np.fft.rfftfreq(N, 1 / SR)
    rms = float(np.sqrt(np.mean(mono ** 2)))
    # How big is the step from the last sample back to the first? Compare it
    # with the typical step inside the loop: a seamless loop is no worse.
    steps = np.abs(np.diff(mono))
    seam = float(np.abs(mono[0] - mono[-1]))
    chroma = np.zeros(12)
    for pc, f in enumerate([261.63 * 2 ** (i / 12) for i in range(12)]):
        for octv in range(-2, 4):
            lo, hi = f * 2 ** octv * 0.97, f * 2 ** octv * 1.03
            chroma[pc] += float(spec[(freqs > lo) & (freqs < hi)].sum())
    chroma /= chroma.max() + 1e-9
    return {
        "peak_dbfs": round(20 * math.log10(float(np.max(np.abs(stereo))) + 1e-9), 1),
        "rms_dbfs": round(20 * math.log10(rms + 1e-9), 1),
        "centroid_hz": round(float((spec * freqs).sum() / (spec.sum() + 1e-9))),
        "seam_vs_median_step": round(seam / (float(np.median(steps)) + 1e-12), 2),
        "strongest_notes": [
            ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][i]
            for i in np.argsort(chroma)[::-1][:3]
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "public", "pads"))
    ap.add_argument("--check", action="store_true", help="print quality metrics")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    report = {}
    for voice in VOICES:
        stereo = finish(voice["render"](), voice.get("tilt", 0.0))
        path = os.path.join(out, f"{voice['id']}.wav")
        write_wav(path, stereo)
        size = os.path.getsize(path)
        report[voice["id"]] = {"bytes": size, **(metrics(stereo) if args.check else {})}
        print(f"{voice['id']:8s} {size / 1e6:5.2f} MB  {report[voice['id']]}", flush=True)
    if args.check:
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
