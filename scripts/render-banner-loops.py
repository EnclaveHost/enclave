#!/usr/bin/env python3
"""Retime the exported Runway clips into eased, silent website loops.

Requires FFmpeg and NumPy. Source directory contains {scene}-original.mp4.
"""
import argparse
import json
import math
from pathlib import Path
import subprocess

import numpy as np


def render(source, target, seconds, fps):
    info = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", str(source),
    ]))["streams"][0]
    width, height = info["width"], info["height"]
    raw = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(source), "-f", "rawvideo",
        "-pix_fmt", "rgb24", "-an", "pipe:1",
    ])
    frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, height, width, 3)
    count = round(seconds * fps)
    target.parent.mkdir(parents=True, exist_ok=True)
    encoder = subprocess.Popen([
        "ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}", "-r", str(fps), "-i", "pipe:0", "-an",
        "-c:v", "libx264", "-crf", "24", "-preset", "slow",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(target),
    ], stdin=subprocess.PIPE)
    try:
        for index in range(count):
            # A full cosine cycle travels forward and back with zero velocity
            # at both turnarounds, including the seam between video loops.
            position = (len(frames) - 1) * (1 - math.cos(2 * math.pi * index / count)) / 2
            left = int(position)
            right = min(left + 1, len(frames) - 1)
            weight = position - left
            # Blend adjacent source frames so slow sections do not stutter
            # through repeated 24fps frames. No geometry synthesis is applied.
            frame = np.rint(frames[left].astype(np.float32) * (1 - weight)
                            + frames[right].astype(np.float32) * weight).astype(np.uint8)
            encoder.stdin.write(frame.tobytes())
    finally:
        encoder.stdin.close()
        result = encoder.wait()
    if result:
        raise RuntimeError(f"FFmpeg failed for {source}: {result}")
    print(f"{target.name}: {count} frames, {seconds}s, {target.stat().st_size:,} bytes", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("site/assets"))
    parser.add_argument("--seconds", type=float, default=16)
    parser.add_argument("--fps", type=int, default=30)
    args = parser.parse_args()
    if args.seconds <= 0 or args.fps <= 0:
        parser.error("seconds and fps must be positive")
    for scene in ("compute", "apps", "develop", "host"):
        render(args.source_dir / f"{scene}-original.mp4",
               args.output_dir / f"{scene}-cinematic.mp4", args.seconds, args.fps)
