#!/usr/bin/env python3
"""Qualify tiny-graph thread selection against six-thread kernel outputs."""
import argparse, os, subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--engine-src',type=Path,required=True)
p.add_argument('--engine-build',type=Path,required=True)
p.add_argument('--out',type=Path,required=True)
a=p.parse_args();repo=Path(__file__).resolve().parents[2];a.out.mkdir()
lib=a.engine_build.resolve()/'bin';exe=a.out.resolve()/'fixture'
subprocess.run(['g++','-O2','-DGGML_MAX_NAME=128','-I',str(a.engine_src.resolve()/'ggml/include'),str(repo/'test/fixtures/cpu-small-graph.cpp'),'-L',str(lib),'-lggml-cpu','-lggml','-lggml-base','-Wl,-rpath,'+str(lib),'-o',str(exe)],check=True)
subprocess.run([str(exe)],check=True)
