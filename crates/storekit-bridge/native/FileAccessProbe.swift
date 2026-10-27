// Native acceptance harness only; never compiled into the product bridge.
import AppKit

@MainActor final class Probe: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let status = NSTextField(wrappingLabelWithString: "Choose a disposable fixture folder containing probe.txt; then verify access after restarting this app.")
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 280), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Nodal Sandbox Bookmark Probe"
        let choose = NSButton(title: "Choose fixture folder", target: self, action: #selector(selectFolder))
        let verify = NSButton(title: "Verify saved access", target: self, action: #selector(verifyAccess))
        let stack = NSStackView(views: [choose, verify, status])
        stack.orientation = .vertical; stack.spacing = 20
        stack.frame = NSRect(x: 24, y: 24, width: 632, height: 230)
        window.contentView?.addSubview(stack)
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    @objc func selectFolder() {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { status.stringValue = "Cancelled; saved permission unchanged."; return }
        if url.path.withCString({ nodalRememberFile($0) }) == 1 {
            UserDefaults.standard.set(url.path, forKey: "ProbePath")
            status.stringValue = "Permission saved. Quit and reopen, then verify."
        } else { status.stringValue = "FAILED: bookmark creation" }
    }
    @objc func verifyAccess() {
        guard let path = UserDefaults.standard.string(forKey: "ProbePath"),
              let handle = path.withCString({ nodalAccessFile($0) }) else {
            status.stringValue = "Permission unavailable; choose the fixture folder again."; return
        }
        defer { nodalReleaseFile(handle) }
        do { status.stringValue = "PASS: " + (try String(contentsOfFile: path + "/probe.txt", encoding: .utf8)) }
        catch { status.stringValue = "FAILED: fixture read" }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
@main struct Main {
    @MainActor static func main() {
        let delegate = Probe()
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.delegate = delegate
        NSApplication.shared.run()
        _ = delegate
    }
}
