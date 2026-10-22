#!/bin/bash
# Kotlin compile check of the EnclaveDNS Android app sources: CONTROL (tag v0.1.4, unmodified) and CANDIDATE (fix/).
# Success = the compiler's own exit status 0 for each side. Output is saved whole; class counts are extra evidence only.
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/phone-dns-recovery
CP="/home/steven/.gradle/caches/modules-2/files-2.1/org.jetbrains/annotations/23.0.0/8cc20c07506ec18e0834947b84a864bfc094484e/annotations-23.0.0.jar:/home/steven/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-compiler-embeddable/2.1.21/70a69b95905e33806fbee6c6c9c48e2b2b2b4da4/kotlin-compiler-embeddable-2.1.21.jar:/home/steven/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.1.21/97a0975aa19d925e109537af60eb46902920015c/kotlin-stdlib-2.1.21.jar:/home/steven/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-script-runtime/2.1.21/e274d560d10526099330411c45961f04d85e77b9/kotlin-script-runtime-2.1.21.jar:/home/steven/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-reflect/2.0.21/669e1d35e4ca1797f9ddb2830dd6c36c0ca531e4/kotlin-reflect-2.0.21.jar:/home/steven/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-daemon-embeddable/2.1.21/2376f98b59395adad949ca19811283fafb1b2e31/kotlin-daemon-embeddable-2.1.21.jar:/home/steven/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.8.1/bb0e192bd7c2b6b8217440d36e9758e377e450/kotlinx-coroutines-core-jvm-1.8.1.jar:/home/steven/.gradle/caches/modules-2/files-2.1/org.jetbrains.intellij.deps/trove4j/1.0.20200330/3afb14d5f9ceb459d724e907a21145e8ff394f02/trove4j-1.0.20200330.jar"
LIBS="/home/steven/Android/Sdk/platforms/android-35/android.jar:/home/steven/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.1.21/97a0975aa19d925e109537af60eb46902920015c/kotlin-stdlib-2.1.21.jar"
CTRL=$(mktemp -d); trap 'rm -rf "$CTRL"' EXIT
git -C src archive v0.1.4 android/app/src/main/java | tar -x -C "$CTRL"
overall=0
for side in control candidate; do
  if [ $side = control ]; then S="$CTRL/android/app/src/main/java"; else S=fix/android/app/src/main/java; fi
  out=claude/kotlin-out-$side; rm -rf "$out"; mkdir -p "$out"
  set +e
  java -Xmx640m -cp "$CP" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-jdk -no-reflect -jvm-target 17 \
    -classpath "$LIBS" -d "$out" $(find "$S" -name '*.kt' | sort) > "claude/kotlin-$side.log" 2>&1
  rc=$?
  set -e
  n=$(find "$out" -name '*.class' | wc -l)
  echo "$side: compiler exit=$rc classes=$n sources=$(find "$S" -name '*.kt' | wc -l) log=claude/kotlin-$side.log"
  grep -E '^(error|exception):|^e: ' "claude/kotlin-$side.log" | head -20 || true
  [ $rc -eq 0 ] || overall=1
done
exit $overall
