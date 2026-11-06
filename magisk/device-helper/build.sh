#!/bin/sh
set -eu
root=$(CDPATH= cd -- "${0%/*}" && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
[ -n "$sdk" ] || { echo '需要 ANDROID_HOME 构建按需设备控制桥接' >&2; exit 1; }
platform=$(find "$sdk/platforms" -mindepth 2 -maxdepth 2 -name android.jar | sort -V | tail -n 1)
compiler=$(find "$sdk/build-tools" -mindepth 2 -maxdepth 2 -name d8 | sort -V | tail -n 1)
[ -f "$platform" ] && [ -f "$compiler" ] || { echo '缺少 Android SDK Platform (API 30+) 或 Build Tools' >&2; exit 1; }
out=${1:-$root/out}
mkdir -p "$out/classes"
"${JAVA_HOME:+$JAVA_HOME/bin/}javac" --release 8 -encoding UTF-8 -classpath "$platform" -d "$out/classes" "$root/src/DeviceControl.java"
"${JAVA_HOME:+$JAVA_HOME/bin/}jar" cf "$out/input.jar" -C "$out/classes" .
"$compiler" --release --min-api 30 --lib "$platform" --output "$out" "$out/input.jar"
"${JAVA_HOME:+$JAVA_HOME/bin/}jar" cf "$out/device-control.jar" -C "$out" classes.dex
