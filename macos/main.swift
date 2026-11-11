// WiFi Surveyor: dock app that scans with CoreWLAN, runs the Python server, and opens the UI in the browser.
// It must be an .app bundle because macOS only reveals SSIDs/BSSIDs to apps holding Location permission.
import AppKit
import CoreLocation
import CoreWLAN
import Foundation

struct Config {
    let root: String
    let python: String
    let port: Int
    let interval: Double
    var feed: String { root + "/data/feed.jsonl" }
    var log: String { root + "/data/server.log" }
    var url: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    // SurveyorRoot/SurveyorPython are written into Info.plist by build.sh.
    static func load() -> Config? {
        let info = Bundle.main.infoDictionary ?? [:]
        guard let root = info["SurveyorRoot"] as? String, let python = info["SurveyorPython"] as? String else { return nil }
        let d = UserDefaults.standard
        let port = d.integer(forKey: "port")
        let interval = d.double(forKey: "interval")
        return Config(root: root, python: python, port: port > 0 ? port : 8765, interval: interval > 0 ? interval : 1)
    }
}

func j(_ v: Any?) -> Any { v ?? NSNull() }

// CoreWLAN returns nil for names that aren't valid UTF-8; hidden networks have empty/zeroed bytes.
func ssidName(_ name: String?, _ data: Data?) -> Any {
    if let name, !name.isEmpty { return name }
    guard let d = data, d.contains(where: { $0 != 0 }) else { return NSNull() }
    if let s = String(data: d, encoding: .utf8) ?? String(data: d, encoding: .isoLatin1) { return s }
    return NSNull()
}

let phyNames: [Int: String] = [1: "a", 2: "b", 3: "g", 4: "n", 5: "ac", 6: "ax", 7: "be"]

func bestPHY(_ n: CWNetwork) -> Any {
    for raw in stride(from: 7, through: 1, by: -1) {
        if let m = CWPHYMode(rawValue: raw), n.supportsPHYMode(m) { return phyNames[raw]! }
    }
    return NSNull()
}

func bandName(_ ch: CWChannel?) -> Any {
    guard let ch else { return NSNull() }
    switch ch.channelBand.rawValue {
    case 1: return "2.4"
    case 2: return "5"
    case 3: return "6"
    default: return NSNull()
    }
}

func widthMHz(_ ch: CWChannel?) -> Any {
    guard let ch else { return NSNull() }
    switch ch.channelWidth.rawValue {
    case 1: return 20
    case 2: return 40
    case 3: return 80
    case 4: return 160
    case 5: return 320
    default: return NSNull()
    }
}

func authName(_ s: CLAuthorizationStatus) -> String {
    switch s.rawValue {
    case 0: return "notDetermined"
    case 1: return "restricted"
    case 2: return "denied"
    case 3: return "authorizedAlways"
    case 4: return "authorizedWhenInUse"
    default: return "unknown"
    }
}

final class Feed: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()

    init?(path: String) {
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let h = FileHandle(forWritingAtPath: path) else { return nil }
        handle = h
    }

    func emit(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        lock.lock()
        defer { lock.unlock() }
        handle.seekToEndOfFile()
        handle.write(data)
        handle.write(Data([0x0A]))
    }
}

final class Poller: @unchecked Sendable {
    let interval: Double
    let feed: Feed
    private var started = false
    private var stopped = false
    private let lock = NSLock()

    init(interval: Double, feed: Feed) {
        self.interval = interval
        self.feed = feed
    }

    func start() {
        lock.lock()
        defer { lock.unlock() }
        if started || stopped { return }
        started = true
        Thread { self.loop() }.start()
    }

    func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    private var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    private func loop() {
        let client = CWWiFiClient.shared()
        while !isStopped {
            let t0 = Date()
            autoreleasepool { scanOnce(client) }
            let wait = interval - Date().timeIntervalSince(t0)
            if wait > 0 { Thread.sleep(forTimeInterval: wait) }
        }
    }

    private func scanOnce(_ client: CWWiFiClient) {
        let ts = Date().timeIntervalSince1970
        guard let iface = client.interface() else {
            feed.emit(["type": "scan", "ts": ts, "error": "no Wi-Fi interface", "networks": [Any]()])
            return
        }
        let rssi = iface.rssiValue()
        let noise = iface.noiseMeasurement()
        let ch = iface.wlanChannel()
        var rec: [String: Any] = [
            "type": "scan",
            "ts": ts,
            "iface": j(iface.interfaceName),
            "connected": [
                "ssid": ssidName(iface.ssid(), iface.ssidData()),
                "bssid": j(iface.bssid()),
                "rssi": j(rssi == 0 ? nil : rssi),
                "noise": j(noise == 0 ? nil : noise),
                "channel": j(ch?.channelNumber),
                "band": bandName(ch),
                "width": widthMHz(ch),
                "tx_rate": iface.transmitRate(),
                "tx_power": iface.transmitPower(),
                "phy": j(phyNames[iface.activePHYMode().rawValue]),
                "country": j(iface.countryCode()),
            ] as [String: Any],
        ]
        var nets: [[String: Any]] = []
        do {
            for n in try iface.scanForNetworks(withSSID: nil) {
                nets.append([
                    "ssid": ssidName(n.ssid, n.ssidData),
                    "bssid": j(n.bssid),
                    "rssi": n.rssiValue,
                    "noise": n.noiseMeasurement,
                    "channel": j(n.wlanChannel?.channelNumber),
                    "band": bandName(n.wlanChannel),
                    "width": widthMHz(n.wlanChannel),
                    "phy": bestPHY(n),
                ])
            }
        } catch {
            rec["error"] = error.localizedDescription
        }
        rec["networks"] = nets
        feed.emit(rec)
    }
}

final class Locator: NSObject, CLLocationManagerDelegate {
    let manager = CLLocationManager()
    let poller: Poller

    init(poller: Poller) {
        self.poller = poller
        super.init()
        manager.delegate = self
    }

    func begin() {
        emitStatus("starting")
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
        // Scan anyway if the prompt is never answered; names are just redacted.
        let p = poller
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { p.start() }
    }

    func emitStatus(_ event: String) {
        poller.feed.emit([
            "type": "status", "event": event, "pid": Int(getpid()),
            "auth": authName(manager.authorizationStatus), "ts": Date().timeIntervalSince1970,
        ])
    }

    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        emitStatus("auth")
        if m.authorizationStatus.rawValue != 0 {
            m.stopUpdatingLocation()
            poller.start()
        }
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        m.stopUpdatingLocation()
    }

    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {}
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let cfg: Config
    let poller: Poller
    var locator: Locator?
    var server: Process?
    var quitting = false
    var sigterm: DispatchSourceSignal?

    init(cfg: Config, feed: Feed) {
        self.cfg = cfg
        self.poller = Poller(interval: cfg.interval, feed: feed)
        super.init()
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        // The server sends SIGTERM to us when "Quit" is pressed in the web UI.
        signal(SIGTERM, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler { Task { @MainActor in NSApp.terminate(nil) } }
        src.resume()
        sigterm = src
        locator = Locator(poller: poller)
        locator?.begin()
        startServer()
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let menu = NSMenu()
        let open = NSMenuItem(title: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)
        let log = NSMenuItem(title: "Show Server Log", action: #selector(showLog), keyEquivalent: "l")
        log.target = self
        menu.addItem(log)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit WiFi Surveyor", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = menu
        NSApp.mainMenu = main
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        let open = NSMenuItem(title: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        return menu
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openBrowser()
        return false
    }

    @objc func openBrowser() { NSWorkspace.shared.open(cfg.url) }

    @objc func showLog() { NSWorkspace.shared.open(URL(fileURLWithPath: cfg.log)) }

    func startServer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cfg.python)
        p.arguments = ["-u", cfg.root + "/server/surveyor.py", "--feed", cfg.feed, "--parent-pid", String(getpid()),
                       "--port", String(cfg.port), "--interval", String(cfg.interval)]
        p.currentDirectoryURL = URL(fileURLWithPath: cfg.root)
        FileManager.default.createFile(atPath: cfg.log, contents: nil)
        if let log = FileHandle(forWritingAtPath: cfg.log) {
            p.standardOutput = log
            p.standardError = log
        }
        p.terminationHandler = { proc in
            let code = proc.terminationStatus
            Task { @MainActor in self.serverExited(code) }
        }
        do {
            try p.run()
        } catch {
            fatal("Could not start Python at \(cfg.python): \(error.localizedDescription)")
            return
        }
        server = p
        Task { await self.openWhenReady() }
    }

    func openWhenReady() async {
        var req = URLRequest(url: cfg.url.appendingPathComponent("api/status"))
        req.timeoutInterval = 1
        for _ in 0..<80 {
            if quitting { return }
            if let (_, resp) = try? await URLSession.shared.data(for: req),
               (resp as? HTTPURLResponse)?.statusCode == 200 {
                openBrowser()
                return
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        fatal("The surveyor server did not start. See \(cfg.log)")
    }

    func serverExited(_ code: Int32) {
        if !quitting { fatal("The surveyor server stopped unexpectedly (exit \(code)). See \(cfg.log)") }
    }

    func fatal(_ message: String) {
        if quitting { return }
        let alert = NSAlert()
        alert.messageText = "WiFi Surveyor"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        poller.stop()
        guard let p = server, p.isRunning else { return .terminateNow }
        // SIGTERM lets the server end the recording and flush the database. Wait here synchronously:
        // .terminateLater runs a modal run loop in which MainActor tasks never execute.
        let pid = p.processIdentifier
        kill(pid, SIGTERM)
        var status: Int32 = 0
        for _ in 0..<100 {
            if waitpid(pid, &status, WNOHANG) != 0 { return .terminateNow }
            usleep(50_000)
        }
        kill(pid, SIGKILL)
        return .terminateNow
    }
}

func drawIcon(_ s: CGFloat) {
    let tile = NSBezierPath(roundedRect: NSRect(x: s * 0.1, y: s * 0.1, width: s * 0.8, height: s * 0.8),
                            xRadius: s * 0.18, yRadius: s * 0.18)
    NSGradient(starting: NSColor(calibratedRed: 0.0, green: 0.72, blue: 0.75, alpha: 1),
               ending: NSColor(calibratedRed: 0.05, green: 0.25, blue: 0.75, alpha: 1))!.draw(in: tile, angle: 90)
    NSColor.white.setStroke()
    NSColor.white.setFill()
    let c = NSPoint(x: s * 0.5, y: s * 0.38)
    for r in [0.13, 0.23, 0.33] {
        let arc = NSBezierPath()
        arc.appendArc(withCenter: c, radius: s * r, startAngle: 45, endAngle: 135)
        arc.lineWidth = s * 0.055
        arc.lineCapStyle = .round
        arc.stroke()
    }
    NSBezierPath(ovalIn: NSRect(x: c.x - s * 0.045, y: c.y - s * 0.045, width: s * 0.09, height: s * 0.09)).fill()
    let graph = NSBezierPath()
    let ys: [CGFloat] = [0.20, 0.24, 0.18, 0.25, 0.21, 0.26, 0.22]
    for (i, y) in ys.enumerated() {
        let p = NSPoint(x: s * (0.2 + 0.6 * CGFloat(i) / CGFloat(ys.count - 1)), y: s * y)
        i == 0 ? graph.move(to: p) : graph.line(to: p)
    }
    graph.lineWidth = s * 0.025
    graph.lineCapStyle = .round
    graph.lineJoinStyle = .round
    NSColor(calibratedRed: 1, green: 0.85, blue: 0.2, alpha: 1).setStroke()
    graph.stroke()
}

func iconPNG(_ px: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    drawIcon(CGFloat(px))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

// ICNS = "icns" + total length, then (type, length, PNG) entries; all lengths big-endian.
func makeIcns(_ path: String) {
    func be32(_ v: Int) -> Data { withUnsafeBytes(of: UInt32(v).bigEndian) { Data($0) } }
    var body = Data()
    for (type, px) in [("icp4", 16), ("ic11", 32), ("icp5", 32), ("ic12", 64), ("ic07", 128),
                       ("ic13", 256), ("ic08", 256), ("ic14", 512), ("ic09", 512), ("ic10", 1024)] {
        guard let png = iconPNG(px) else { continue }
        body += Data(type.utf8) + be32(png.count + 8) + png
    }
    try? (Data("icns".utf8) + be32(body.count + 8) + body).write(to: URL(fileURLWithPath: path))
}

let args = CommandLine.arguments
if let i = args.firstIndex(of: "--make-icon"), i + 1 < args.count {
    makeIcns(args[i + 1])
    exit(0)
}
guard let cfg = Config.load() else {
    FileHandle.standardError.write(Data("Info.plist is missing SurveyorRoot/SurveyorPython; build with build.sh\n".utf8))
    exit(2)
}
umask(0o077)
try? FileManager.default.createDirectory(atPath: cfg.root + "/data", withIntermediateDirectories: true)
guard let feed = Feed(path: cfg.feed) else {
    FileHandle.standardError.write(Data("Cannot write \(cfg.feed)\n".utf8))
    exit(2)
}
MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let delegate = AppDelegate(cfg: cfg, feed: feed)
    app.delegate = delegate
    app.run()
}
