#!/usr/bin/env bash
# Windows portable wrapper; dependency overrides: JAVA_HOME, ANDROID_BUILD_TOOLS, ANDROID_JAR.
set -euo pipefail
PROJ="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
pwsh -NoProfile -File "$PROJ/build.ps1" "$@"
