import AppKit
import DashboardUI
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
    let settings: AppSettings
    var window: DashboardWindow?
    var authBridge: DashboardAuthBridge?
    var webView: WKWebView?
    var placeholder: NSHostingView<DashboardDownView>?
    let dock: DockPresence
    var isOpen = false
    var loadedBase: URL?
    var failedURL: URL?
    var retryTask: Task<Void, Never>?
    var observers: [NSKeyValueObservation] = []
    var backItem: NSToolbarItem?
    var forwardItem: NSToolbarItem?
    weak var searchField: NSSearchField?

    static let frameName = "CommanderDashboardWindow"
    static let installHint = "bash ops/mac/dashboard-install.sh"

    init(settings: AppSettings, dock: DockPresence) {
        self.settings = settings
        self.dock = dock
    }

    // MARK: ochish / yopish

    func show(_ target: DashboardTarget) {
        let base = settings.dashboardURL
        let w = ensureWindow()
        // ⌘D / Dock bosilishi (`.overview`) ochiq sahifani almashtirmaydi; chuqur havola esa doim o'sha sahifaga.
        let mustNavigate = target != .overview || webView?.url == nil || loadedBase != base || failedURL != nil
        present(w, loading: mustNavigate ? target.url(base: base) : nil, label: target.path)
    }

    /// Native ekrani hali yo'q marshrutni shu web oynasida ochadi (`Route.webPath`; o'tish davri).
    func show(webPath path: String) {
        var components = URLComponents(url: settings.dashboardURL, resolvingAgainstBaseURL: false)
        components?.path = path
        components?.query = nil
        components?.fragment = nil
        present(ensureWindow(), loading: components?.url, label: path)
    }

    func ensureWindow() -> DashboardWindow {
        let w = window ?? makeWindow()
        window = w
        return w
    }

    func present(_ w: DashboardWindow, loading url: URL?, label: String) {
        if let url { load(url) }
        if !isOpen {
            isOpen = true
            dock.windowOpened()
        }
        DebugLog.write("dash show target=\(label) \(DebugLog.windowState())")
        NSApp.activate()
        w.makeKeyAndOrderFront(nil)
        // `.accessory` -> `.regular` dan keyin oyna ba'zan orqada qoladi: keyingi siklda yana oldinga.
        Task { @MainActor in w.makeKeyAndOrderFront(nil) }
    }

    func windowWillClose(_ notification: Notification) {
        isOpen = false
        retryTask?.cancel()
        retryTask = nil
        dock.windowClosed()
    }

    func load(_ url: URL) {
        guard let webView else { return }
        loadedBase = settings.dashboardURL
        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 15))
    }

    // MARK: oyna

    func makeWindow() -> DashboardWindow {
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
        w.clickProbe = { [weak self] e in self?.probe(e) }

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

    func makeWebView() -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // Doimiy ma'lumot ombori: mavzu tanlovi (localStorage) va sessiya cookie'si saqlanadi.
        cfg.websiteDataStore = .default()
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        cfg.applicationNameForUserAgent = "CommanderMac"
        // H-01: yagona native ko'prik (Touch ID bilan sessiya/qayta tasdiq). Boshqa script handler'lar YO'Q.
        let bridge = DashboardAuthBridge(settings: settings)
        cfg.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: DashboardAuthBridge.name)
        authBridge = bridge
        if DebugLog.enabled {
            // Diagnostika: sahifa xatolarini yig'adi (native ko'prik yo'q; `probe` evaluateJavaScript bilan o'qiydi).
            let js = """
            (function(){var e=window.__cmdDbg=[];function p(m){e.push(String(m).slice(0,300));if(e.length>30)e.shift();}
            window.addEventListener('error',function(x){p('error: '+x.message+' @'+(x.filename||'')+':'+x.lineno);});
            window.addEventListener('unhandledrejection',function(x){p('rejection: '+(x.reason&&x.reason.message||x.reason));});
            var ce=console.error;console.error=function(){p('console: '+Array.prototype.join.call(arguments,' '));return ce.apply(console,arguments);};})();
            """
            cfg.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        wv.allowsMagnification = true
        return wv
    }

    func observe(_ wv: WKWebView) {
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

    func updateTitle(_ title: String?) {
        guard failedURL == nil else { return }
        let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        window?.title = t.isEmpty ? "Commander" : t
    }

    // MARK: dashboard ishlamayapti

    func showDown(url: URL, error: Error) {
        failedURL = url
        window?.title = "Commander — dashboard ishlamayapti"
        placeholder?.rootView = DashboardDownView(url: settings.dashboardURL.absoluteString, detail: error.localizedDescription,
                                                  hint: Self.installHint, onRetry: { [weak self] in self?.retry() })
        placeholder?.isHidden = false
        webView?.isHidden = true
        scheduleRetry()
    }

    func hideDown() {
        failedURL = nil
        retryTask?.cancel()
        retryTask = nil
        placeholder?.isHidden = true
        webView?.isHidden = false
        updateTitle(webView?.title)
    }

    func retry() {
        guard let url = failedURL ?? DashboardTarget.overview.url(base: settings.dashboardURL) else { return }
        load(url)
    }

    func scheduleRetry() {
        guard isOpen, retryTask == nil else { return }
        retryTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self, self.isOpen, self.failedURL != nil else { return }
                self.retry()
            }
        }
    }
}
