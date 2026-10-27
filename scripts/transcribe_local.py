"""Local transcription with faster-whisper (free, offline after the first model download).

Usage: python transcribe_local.py <audio-file> [model=base] [device=cpu]
Prints one JSON document to stdout; progress lines ("PROGRESS 0.42") go to stderr.
Install: python -m pip install faster-whisper "av<17"
"""
import json
import sys


def main() -> None:
    audio = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
    device = sys.argv[3] if len(sys.argv) > 3 else "cpu"

    from faster_whisper import WhisperModel

    compute_type = "int8" if device == "cpu" else "float16"
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments_iter, info = model.transcribe(audio, word_timestamps=True, vad_filter=True)
    total = max(float(info.duration or 0), 1.0)

    segments = []
    for seg in segments_iter:
        segments.append(
            {
                "start": float(seg.start),
                "end": float(seg.end),
                "text": seg.text.strip(),
                "words": [
                    {"start": float(w.start), "end": float(w.end), "word": w.word.strip()}
                    for w in (seg.words or [])
                    if w.word.strip()
                ],
            }
        )
        print(f"PROGRESS {min(float(seg.end) / total, 1.0):.3f}", file=sys.stderr, flush=True)

    sys.stdout.write(json.dumps({"language": info.language, "segments": segments}))


if __name__ == "__main__":
    main()
