# Additional root evidence at 16:12 UTC

Root read-only QMP result saved ../logs/qmp-io-readonly-1613.json (filename label is not capture time). QEMU11.1.2. Nodes l10/base0 use qcow2 direct=false,no-flush=false,writeback=true. All failed read/write/flush counts zero.

Brief Base downloader pause: systemctl freeze refused because Type=oneshot activation job still pending; this is not a freeze success. Instead stopped ONLY its cgroup processes with SIGSTOP after scheduling systemd CONT90s fallback. Sample at ../logs/io-base-sigstop-1611.txt, later sample ../logs/io-base-sigstop-late-1612.txt. Manually CONT resumed and timer also succeeded. Resumed Base visible5.2%40.29/770.80GiB at16:10:30, serviceactivating/start is normal oneshotdownload. No data deleted/no clientrestart.

After write queue drained, sdc Base zeroIO, but sdb remained100%busy ~35reads/sec4.4KiB/28ms,1.4MB/swrites46ms,10flushes/sec72ms. No instantperformancefixfrompause; shortsampleisnotrigorouscausalbenchmark. EL executed26263566 at16:07:30, checkpointsave16:08:49. Threeblocks~14minutes sincepipeline resumed. Need concreteperformancefix. Currentguest55GiBavailable,readonlymetrics/opscap same.
