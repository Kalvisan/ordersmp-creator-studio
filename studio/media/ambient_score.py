"""Original quiet sound design made from tones and noise, without samples."""
from array import array
import math
from pathlib import Path
import random
import wave


def write_score(path: Path, duration: float, sample_rate=48000):
    randomizer = random.Random(20261023)
    samples = array('h')
    wind = 0.0
    # A warm sustained chord and sparse, soft bells. No source audio is used.
    tones = [(130.8128, 0.040), (196.0, 0.023), (261.6256, 0.016), (329.6276, 0.012)]
    bells = [(0.8, 523.2511), (3.2, 391.9954), (6.8, 659.2551), (8.7, 523.2511)]
    for index in range(round(duration * sample_rate)):
        at = index / sample_rate
        envelope = min(1, at / 1.4) * min(1, max(0, duration - at) / 1.8)
        wind = wind * 0.985 + randomizer.uniform(-1, 1) * 0.015
        for channel in (0, 1):
            pad = sum(amplitude * math.sin(2 * math.pi * frequency * at + channel * 0.035)
                * (0.91 + 0.09 * math.sin(2 * math.pi * 0.13 * at)) for frequency, amplitude in tones)
            bell = 0.0
            for begin, frequency in bells:
                elapsed = at - begin - channel * 0.007
                if elapsed >= 0:
                    attack = min(1, elapsed / 0.08)
                    bell += 0.035 * attack * math.exp(-1.35 * elapsed) * (
                        math.sin(2 * math.pi * frequency * elapsed)
                        + 0.17 * math.sin(2 * math.pi * frequency * 2 * elapsed))
            value = (pad + bell + wind * 0.065) * envelope
            samples.append(round(max(-1, min(1, value)) * 32767))
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples.tobytes())
    return path
