# WiFi Surveyor

A small macOS app for surveying Wi-Fi at home or in an office: it logs the signal strength of every network and access point, lets you tag what you record with the room you're in, and shows where coverage is weak.

- Live charts per network (one line per access point)
- Record sessions, tag rooms as you walk, compare rooms and find dead spots
- Walk mode: full-screen view with big room buttons
- Channel/spectrum view, history, CSV export
- Include/exclude networks you care about

No third-party dependencies: a Swift app (CoreWLAN) plus a Python standard-library server and a plain HTML/JS UI.

## Requirements

- macOS 13+ on Apple silicon
- Xcode Command Line Tools (`xcode-select --install`)
- Python 3.8+

## Build and run

```sh
./build.sh
open WiFiSurveyor.app
```

The app opens the UI in your browser at http://127.0.0.1:8765/. Quit from the Dock, with ⌘Q, or with Quit in the page's ⋯ menu.

On first launch macOS asks for **Location** access. Allow it: without it macOS hides network names and BSSIDs. (Because the app is ad-hoc signed, a rebuild may ask again.)

To review recorded data without scanning: `python3 server/surveyor.py`.

## Data and privacy

Everything stays on your Mac in `data/` (SQLite). Recordings contain nearby network names and BSSIDs, which can reveal your location, so `data/` is git-ignored; don't share it.

## Settings

Scan interval (default 1 s; real speed is limited by how long macOS takes to scan, usually 2–5 s) and port:

```sh
defaults write local.wifisurveyor.app interval 2
defaults write local.wifisurveyor.app port 8765
```

## License

GNU Affero General Public License v3.0 or later. See [LICENSE](LICENSE).
