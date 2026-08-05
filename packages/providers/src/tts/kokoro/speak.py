#!/usr/bin/env python3
"""Synthesizes exactly one WAV file with Kokoro-82M (via the `kokoro-onnx` package).

Invoked as a subprocess by kokoro-tts-provider.ts — never imported or run directly, and never
run by the test suite (tests stub the ProcessRunner). Model weights are downloaded by
scripts/setup-tts.sh into models/tts/, never by this script.

Requires (in the project virtualenv, `.venv/`):
    pip install kokoro-onnx soundfile
"""
import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, help='path to kokoro-v1.0*.onnx')
    parser.add_argument('--voices', required=True, help='path to voices-v1.0.bin')
    parser.add_argument('--voice', required=True, help="a kokoro voice id, e.g. 'af_sarah'")
    parser.add_argument('--text', required=True)
    parser.add_argument('--out', required=True, help='output .wav path')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--lang', default='en-us')
    args = parser.parse_args()

    if not args.text.strip():
        print('speak.py: --text is empty', file=sys.stderr)
        return 1

    # Imported lazily so `--help` works even before dependencies are installed.
    from kokoro_onnx import Kokoro
    import soundfile as sf

    kokoro = Kokoro(args.model, args.voices)
    samples, sample_rate = kokoro.create(
        args.text, voice=args.voice, speed=args.speed, lang=args.lang
    )
    # Explicit PCM_16 so the Node side's WAV-header duration measurement always finds a plain
    # RIFF/PCM file, regardless of what dtype `kokoro.create` happens to return.
    sf.write(args.out, samples, sample_rate, subtype='PCM_16')
    return 0


if __name__ == '__main__':
    sys.exit(main())
