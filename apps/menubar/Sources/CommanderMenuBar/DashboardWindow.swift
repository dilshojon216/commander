import AppKit
import MenuBarCore
import SwiftUI
import WebKit

/// "Commander" oynasi: to'liq web dashboard (WKWebView, `http://127.0.0.1:4318`).
/// - Navigatsiya faqat sozlangan dashboard origin'i ichida; boshqa havolalar tizim brauzerida (`DashboardNavigationPolicy`).
/// - JS ko'prigi FAQAT bitta: `commanderAuth` (H-01: Touch ID bilan kirish/qayta tasdiqlash; `DashboardAuthBridge`). U faqat
///   dashboard origin'ining asosiy freymidan ishlaydi, xabarlari qat'iy tekshiriladi va sirni sahifaga bermaydi.
/// - Oyna ochiq paytda Dock ikonkasi (`.regular`), yopilsa yana faqat menu-bar (`.accessory`).
/// - Dashboard ishlamasa: native "Dashboard ishlamayapti" + Qayta urinish (va har 5 s avtomatik).
@MainActor
final class DashboardWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, NSToolbarDelegate, NSSearchFieldDelegate {
    private let settings: AppSettings
    private var window: DashboardWindow?
    private var authBridge: DashboardAuthBridge?
    private var webView: WKWebView?
    private var placeholder: NSHostingView<DashboardDownView>?
    private var activation = ActivationPolicyState()
    private var isOpen = false
    private var loadedBase: URL?
    private var failedURL: URL?
    private var retryTask: Task<Void, Never>?
    private var observers: [NSKeyValueObservation] = []
    private var backItem: NSToolbarItem?
    private var forwardItem: NSToolbarItem?
    private weak var searchField: NSSearchField?

    static let frameName = "CommanderDashboardWindow"
    static let installHint = "bash ops/mac/dashboard-install.sh"

    init(settings: AppSettings) {
        self.settings = settings
    }

    // MARK: ochish / yopish

    func show(_ target: DashboardTarget) {
        let w = window ?? makeWindow()
        window = w
        let base = settings.dashboardURL
        // ⌘D / Dock bosilishi (`.overview`) ochiq sahifani almashtirmaydi; chuqur havola esa doim o'sha sahifaga.
        let mustNavigate = target != .overview || webView?.url == nil || loadedBase != base || failedURL != nil
        if mustNavigate, let url = target.url(base: base) { load(url) }

        if !isOpen {
            isOpen = true
            apply(activation.windowOpened())
        }
        NSApp.activate()
        w.makeKeyAndOrderFront(nil)
        // `.accessory` -> `.regular` dan keyin oyna ba'zan orqada qoladi: keyingi siklda yana oldinga.
        Task { @MainActor in w.makeKeyAndOrderFront(nil) }
    }

    func windowWillClose(_ notification: Notification) {
        isOpen = false
        retryTask?.cancel()
        retryTask = nil
        apply(activation.windowClosed())
    }

    private func apply(_ policy: ActivationPolicyState.Policy?) {
        guard let policy else { return }
        switch policy {
        case .regular:
            NSApp.setActivationPolicy(.regular)
            NSApp.applicationIconImage = DockIcon.image
        case .accessory:
            NSApp.setActivationPolicy(.accessory)
        }
    }

    private func load(_ url: URL) {
        guard let webView else { return }
        loadedBase = settings.dashboardURL
        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 15))
    }

    // MARK: oyna

    private func makeWindow() -> DashboardWindow {
        let w = DashboardWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                backing: .buffered, defer: false)
        w.title = "Commander"
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.minSize = NSSize(width: 720, height: 480)
        w.delegate = self
        if !w.setFrameUsingName(Self.frameName) { w.center() }
        w.setFrameAutosaveName(Self.frameName)
        w.keyHandler = { [weak self] e in self?.handleKey(e) ?? false }

        let toolbar = NSToolbar(identifier: "CommanderDashboardToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        w.toolbar = toolbar
        w.toolbarStyle = .unified

        let container = NSView()
        let wv = makeWebView()
        wv.frame = container.bounds
        wv.autoresizingMask = [.width, .height]
        container.addSubview(wv)

        let ph = NSHostingView(rootView: DashboardDownView(url: settings.dashboardURL.absoluteString, detail: nil, hint: Self.installHint, onRetry: {}))
        ph.frame = container.bounds
        ph.autoresizingMask = [.width, .height]
        ph.isHidden = true
        container.addSubview(ph)
        placeholder = ph

        w.contentView = container
        webView = wv
        observe(wv)
        return w
    }

    private func makeWebView() -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // Doimiy ma'lumot ombori: mavzu tanlovi (localStorage) va sessiya cookie'si saqlanadi.
        cfg.websiteDataStore = .default()
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        cfg.applicationNameForUserAgent = "CommanderMac"
        // H-01: yagona native ko'prik (Touch ID bilan sessiya/qayta tasdiq). Boshqa script handler'lar YO'Q.
        let bridge = DashboardAuthBridge(settings: settings)
        cfg.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: DashboardAuthBridge.name)
        authBridge = bridge
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        wv.allowsMagnification = true
        return wv
    }

    private func observe(_ wv: WKWebView) {
        observers = [
            wv.observe(\.title, options: [.new]) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.updateTitle(wv.title) }
            },
            wv.observe(\.canGoBack, options: [.new]) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.backItem?.isEnabled = wv.canGoBack }
            },
            wv.observe(\.canGoForward, options: [.new]) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.forwardItem?.isEnabled = wv.canGoForward }
            },
        ]
    }

    private func updateTitle(_ title: String?) {
        guard failedURL == nil else { return }
        let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        window?.title = t.isEmpty ? "Commander" : t
    }

    // MARK: dashboard ishlamayapti

    private func showDown(url: URL, error: Error) {
        failedURL = url
        window?.title = "Commander — dashboard ishlamayapti"
        placeholder?.rootView = DashboardDownView(url: settings.dashboardURL.absoluteString, detail: error.localizedDescription,
                                                  hint: Self.installHint, onRetry: { [weak self] in self?.retry() })
        placeholder?.isHidden = false
        webView?.isHidden = true
        scheduleRetry()
    }

    private func hideDown() {
        failedURL = nil
        retryTask?.cancel()
        retryTask = nil
        placeholder?.isHidden = true
        webView?.isHidden = false
        updateTitle(webView?.title)
    }

    private func retry() {
        guard let url = failedURL ?? DashboardTarget.overview.url(base: settings.dashboardURL) else { return }
        load(url)
    }

    private func scheduleRetry() {
        guard isOpen, retryTask == nil else { return }
        retryTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self, self.isOpen, self.failedURL != nil else { return }
                self.retry()
            }
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let url = navigationAction.request.url
        // targetFrame == nil: target=_blank / window.open — yangi oyna ochilmaydi.
        let newWindow = navigationAction.targetFrame == nil
        let isMain = navigationAction.targetFrame?.isMainFrame ?? true
        switch DashboardNavigationPolicy.decide(url, base: settings.dashboardURL, isMainFrame: isMain) {
        case .allow:
            if newWindow, let url { webView.load(URLRequest(url: url)); return .cancel }
            return .allow
        case .openExternally:
            if let url { NSWorkspace.shared.open(url) }
            return .cancel
        case .cancel:
            if let url { log.notice("dashboard navigation blocked scheme=\(url.scheme ?? "-", privacy: .public)") }
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hideDown()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    private func handleFailure(_ error: Error) {
        let ns = error as NSError
        // Bekor qilingan / siyosat to'xtatgan yuklanish xato emas.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        guard ns.domain == NSURLErrorDomain else { return }
        let url = (ns.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView?.url ?? DashboardTarget.overview.url(base: settings.dashboardURL)
        if let url { showDown(url: url, error: error) }
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open: ichki manzil shu oynada, tashqi manzil brauzerda; yangi WKWebView yaratilmaydi.
        switch DashboardNavigationPolicy.decide(navigationAction.request.url, base: settings.dashboardURL, isMainFrame: true) {
        case .allow: if let u = navigationAction.request.url { webView.load(URLRequest(url: u)) }
        case .openExternally: if let u = navigationAction.request.url { NSWorkspace.shared.open(u) }
        case .cancel: break
        }
        return nil
    }

    // MARK: klaviatura

    private func handleKey(_ e: NSEvent) -> Bool {
        let flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard flags.contains(.command), let key = e.charactersIgnoringModifiers?.lowercased() else { return false }
        let shift = flags.contains(.shift)
        let other = flags.subtracting([.command, .shift, .capsLock, .numericPad, .function])
        guard other.isEmpty else { return false }
        func send(_ sel: String) -> Bool { NSApp.sendAction(Selector(sel), to: nil, from: window) }
        switch (key, shift) {
        case ("r", false): reload(); return true
        case ("[", false): goBack(); return true
        case ("]", false): goForward(); return true
        case ("w", false): window?.performClose(nil); return true
        case ("f", false): focusSearch(); return true
        case ("d", false): return true // oyna allaqachon ochiq
        case ("=", _), ("+", _): webView?.pageZoom = min(3, (webView?.pageZoom ?? 1) + 0.1); return true
        case ("-", false): webView?.pageZoom = max(0.5, (webView?.pageZoom ?? 1) - 0.1); return true
        case ("0", false): webView?.pageZoom = 1; return true
        // Tahrir tugmalari (accessory ilovada asosiy menyu bo'lmasligi mumkin).
        case ("c", false): return send("copy:")
        case ("v", false): return send("paste:")
        case ("x", false): return send("cut:")
        case ("a", false): return send("selectAll:")
        case ("z", false): return send("undo:")
        case ("z", true): return send("redo:")
        default: return false
        }
    }

    // MARK: qidiruv (⌘F)

    private func focusSearch() {
        guard let searchField else { return }
        window?.makeFirstResponder(searchField)
        searchField.selectText(nil)
    }

    private func find(_ text: String, backwards: Bool) {
        guard !text.isEmpty, let webView else { return }
        let cfg = WKFindConfiguration()
        cfg.backwards = backwards
        cfg.wraps = true
        cfg.caseSensitive = false
        webView.find(text, configuration: cfg) { result in
            if !result.matchFound { NSSound.beep() }
        }
    }

    @objc private func searchChanged(_ sender: NSSearchField) {
        find(sender.stringValue, backwards: false)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard let field = control as? NSSearchField else { return false }
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            let back = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
            find(field.stringValue, backwards: back)
            return true
        }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            field.stringValue = ""
            window?.makeFirstResponder(webView)
            return true
        }
        return false
    }

    // MARK: toolbar

    private static let backID = NSToolbarItem.Identifier("dashboard.back")
    private static let forwardID = NSToolbarItem.Identifier("dashboard.forward")
    private static let reloadID = NSToolbarItem.Identifier("dashboard.reload")
    private static let searchID = NSToolbarItem.Identifier("dashboard.search")

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.backID, Self.forwardID, Self.reloadID, .flexibleSpace, Self.searchID]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        func button(_ symbol: String, _ label: String, _ action: Selector) -> NSToolbarItem {
            let item = NSToolbarItem(itemIdentifier: id)
            item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
            item.label = label
            item.toolTip = label
            item.isBordered = true
            item.target = self
            item.action = action
            item.autovalidates = false
            return item
        }
        switch id {
        case Self.backID:
            let item = button("chevron.left", "Orqaga (⌘[)", #selector(goBack))
            item.isEnabled = webView?.canGoBack ?? false
            backItem = item
            return item
        case Self.forwardID:
            let item = button("chevron.right", "Oldinga (⌘])", #selector(goForward))
            item.isEnabled = webView?.canGoForward ?? false
            forwardItem = item
            return item
        case Self.reloadID:
            return button("arrow.clockwise", "Yangilash (⌘R)", #selector(reload))
        case Self.searchID:
            let item = NSSearchToolbarItem(itemIdentifier: id)
            item.searchField.placeholderString = "Sahifada qidirish (⌘F)"
            item.searchField.delegate = self
            item.searchField.target = self
            item.searchField.action = #selector(searchChanged(_:))
            item.searchField.sendsSearchStringImmediately = false
            item.searchField.sendsWholeSearchString = false
            searchField = item.searchField
            return item
        default:
            return nil
        }
    }

    @objc private func goBack() { webView?.goBack() }
    @objc private func goForward() { webView?.goForward() }
    @objc private func reload() { if failedURL != nil { retry() } else { webView?.reload() } }
}

/// Klaviatura yorliqlarini asosiy menyudan oldin ushlash uchun.
final class DashboardWindow: NSWindow {
    var keyHandler: ((NSEvent) -> Bool)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if keyHandler?(event) == true { return true }
        return super.performKeyEquivalent(with: event)
    }
}

/// Dashboard ishlamayotganda ko'rsatiladigan native sahifa.
struct DashboardDownView: View {
    let url: String
    let detail: String?
    let hint: String
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "bolt.horizontal.circle")
                .font(.system(size: 44, weight: .regular))
                .foregroundStyle(Theme.orange)
                .accessibilityHidden(true)
            Text("Dashboard ishlamayapti").font(.system(size: 20, weight: .bold))
            Text("\(url) ga ulanib bo'lmadi.").foregroundStyle(Theme.muted)
            if let detail {
                Text(detail).font(.system(size: 11)).foregroundStyle(Theme.faint).multilineTextAlignment(.center)
            }
            VStack(spacing: 6) {
                Text("Xizmatni o'rnatish yoki qayta ishga tushirish (repo ildizida):").font(.system(size: 12)).foregroundStyle(Theme.muted)
                Text(hint)
                    .font(Theme.mono)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface2))
            }
            Button("Qayta urinish", action: onRetry)
                .keyboardShortcut(.defaultAction)
                .controlSize(.large)
            Text("Har 5 soniyada avtomatik qayta uriniladi.").font(.system(size: 11)).foregroundStyle(Theme.faint)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

/// Dock ikonkasi: maskot (oyna ochiq paytida ko'rinadi).
@MainActor
enum DockIcon {
    private static var cached: NSImage?

    static var image: NSImage {
        if let cached { return cached }
        let img = render()
        cached = img
        return img
    }

    private static func render() -> NSImage {
        let view = ZStack {
            RoundedRectangle(cornerRadius: 112, style: .continuous).fill(Color(hex: 0x1E2128))
                .frame(width: 464, height: 464)
            MascotView(pose: .kutmoqda, light: .blue, height: 400, animated: false)
                .offset(y: 24)
        }
        .frame(width: 512, height: 512)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        return renderer.nsImage ?? NSImage(size: NSSize(width: 512, height: 512))
    }
}
