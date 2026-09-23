#!/bin/bash
# System-wide busy CPU, in whole cores, sampled over 2 s. Called between runs
# when no bench is alive, so whatever it reports is somebody ELSE's work.
read -r _ a b c d e f g h _ < /proc/stat; t1=$((a+b+c+d+e+f+g+h)); i1=$((d+e))
sleep 2
read -r _ a b c d e f g h _ < /proc/stat; t2=$((a+b+c+d+e+f+g+h)); i2=$((d+e))
awk -v dt=$((t2-t1)) -v di=$((i2-i1)) -v n=$(nproc) 'BEGIN{printf "%.2f", dt?(1-di/dt)*n:0}'
