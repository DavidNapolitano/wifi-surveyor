#!/bin/sh
# Builds WiFiSurveyor.app (dock app: scanner + server launcher) with the Xcode Command Line Tools.
set -eu
cd "$(dirname "$0")"
APP=WiFiSurveyor.app
PY="${SURVEYOR_PYTHON:-$(command -v python3)}"
rm -rf "$APP" build/WiFiSurveyor.app build/WiFiScanner.app
rmdir build 2>/dev/null || true
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp macos/Info.plist "$APP/Contents/Info.plist"
plutil -insert SurveyorRoot -string "$PWD" "$APP/Contents/Info.plist"
plutil -insert SurveyorPython -string "$PY" "$APP/Contents/Info.plist"
swiftc -O -swift-version 5 -target arm64-apple-macos13.0 \
    -framework AppKit -framework CoreWLAN -framework CoreLocation \
    macos/main.swift -o "$APP/Contents/MacOS/WiFiSurveyor"
"$APP/Contents/MacOS/WiFiSurveyor" --make-icon "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"
echo "Built $APP (python: $PY). Launch with: open $APP"
