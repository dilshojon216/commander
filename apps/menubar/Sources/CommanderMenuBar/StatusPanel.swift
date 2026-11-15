import AppKit
import MenuBarCore
import Observation
import SwiftUI

/// Menu-bar ikonkasi + panel. MenuBarExtra(.window) o'rniga: u panelni ikonka ostida (menu bar o'rtasida ham) ochar va
/// balandligini cheklab qo'yardi. Bu yerda panel doim ekranning o'ng yuqori burchagida, ekran balandligigacha ochiladi.
@MainActor
final class StatusPanelController: NSObject {
    static let width: CGFloat = 420
    private static let margin: CGFloat = 8

    private let model: AppModel
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var panel: KeyablePanel?
    private var hosting: NSHostingController<PanelContainer>?
    private var eventMonitors: [Any] = []
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []

    init(model: AppModel) {
        self.model = model
        super.init()
        if let button = item.button {
            button.target = self
            button.action = #selector(toggle)
            button.imagePosition = .imageLeading
            button.font = .monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        }
        observeLabel()
    }

    var isVisible: Bool { panel?.isVisible == true }

    @objc private func toggle() {
        if isVisible { close() } else { show() }
    }

    func show() {
        guard !isVisible else { return }
        let panel = self.panel ?? makePanel()
        self.panel = panel
        model.panelAppeared()
        layout(animate: false)
        panel.alphaValue = 0
        panel.makeKeyAndOrderFront(nil)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            panel.animator().alphaValue = 1
        }
        item.button?.highlight(true)
        installMonitors()
        DebugLog.write("panel show \(DebugLog.windowState())")
    }

    func close() {
        guard let panel, panel.isVisible else { return }
        removeMonitors()
        panel.orderOut(nil)
        item.button?.highlight(false)
        model.panelDisappeared()
        // Panel kalit oyna bo'lgan edi: yopilgach ilovaning ochiq oynasi (dashboard) kalit holatini qaytarib olsin,
        // aks holda undagi bosishlar faqat oynani faollashtiradi va havolalar ishlamaydi.
        if NSApp.isActive, NSApp.keyWindow == nil || NSApp.keyWindow === panel,
           let w = NSApp.windows.first(where: { $0 !== panel && $0.isVisible && $0.canBecomeKey && $0.level == .normal }) {
            w.makeKey()
        }
        DebugLog.write("panel close \(DebugLog.windowState())")
    }

    // MARK: joylashuv

    private var screen: NSScreen? { item.button?.window?.screen ?? NSScreen.main }

    /// Panel tanasi (aylanadigan qism) uchun eng katta balandlik: ekran balandligidan sarlavha/pastki qator joyi ayriladi.
    private var maxBodyHeight: CGFloat {
        let vf = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return max(240, vf.height - Self.margin * 2 - 150)
    }

    /// O'ng yuqori burchakka yopishtiradi; balandlik kontentga mos (ekrandan oshmaydi).
    private func layout(animate: Bool) {
        guard let panel, let hosting, let screen else { return }
        hosting.rootView = PanelContainer(model: model, maxBodyHeight: maxBodyHeight) { [weak self] in self?.relayoutSoon() }
        let vf = screen.visibleFrame
        // `fittingSize` sizingOptions bo'sh bo'lganda 0 qaytaradi: balandlikni SwiftUI'dan to'g'ridan-to'g'ri so'raymiz.
        let fit = hosting.sizeThatFits(in: NSSize(width: Self.width, height: vf.height))
        let size = NSSize(width: Self.width, height: min(max(fit.height, 120), vf.height - Self.margin * 2))
        let frame = NSRect(x: vf.maxX - size.width - Self.margin, y: vf.maxY - size.height - Self.margin, width: size.width, height: size.height)
        panel.setFrame(frame, display: true, animate: animate && panel.isVisible)
    }

    private var relayoutPending = false
    private func relayoutSoon() {
        guard !relayoutPending else { return }
        relayoutPending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.relayoutPending = false
            if self.isVisible { self.layout(animate: false) }
        }
    }

    private func makePanel() -> KeyablePanel {
        let p = KeyablePanel(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 400),
                             styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: true)
        p.level = .statusBar
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.isMovable = false
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        p.onEscape = { [weak self] in
            if self?.model.showSettings == true { self?.model.showSettings = false } else { self?.close() }
        }
        let h = NSHostingController(rootView: PanelContainer(model: model, maxBodyHeight: maxBodyHeight) { [weak self] in self?.relayoutSoon() })
        h.sizingOptions = []
        p.contentViewController = h
        hosting = h
        return p
    }

    // MARK: yopilish: tashqariga bosish, boshqa Space

    private func installMonitors() {
        removeMonitors()
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }) { eventMonitors.append(m) }
        // O'z oynalarimiz (dashboard, juftlash) ichiga bosish ham panelni yopadi: aks holda panel ular ustida qolib, bosishni to'sadi.
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] e in
            MainActor.assumeIsolated {
                DebugLog.write("panel-open click win=\(e.window.map { "\(type(of: $0))#\($0.windowNumber)" } ?? "nil")")
                if let self, e.window !== self.panel, e.window !== self.item.button?.window { self.close() }
            }
            return e
        }) { eventMonitors.append(m) }
        let ws = NSWorkspace.shared.notificationCenter
        observers.append((ws, ws.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }))
        let nc = NotificationCenter.default
        observers.append((nc, nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.relayoutSoon() }
        }))
    }

    private func removeMonitors() {
        for m in eventMonitors { NSEvent.removeMonitor(m) }
        for (center, o) in observers { center.removeObserver(o) }
        eventMonitors.removeAll()
        observers.removeAll()
    }

    // MARK: menu-bar yorlig'i (maskot boshi + ixcham matn)

    private func observeLabel() {
        withObservationTracking {
            updateLabel()
        } onChange: { [weak self] in
            Task { @MainActor in self?.observeLabel() }
        }
    }

    private func updateLabel() {
        guard let button = item.button else { return }
        let mood = model.mood
        let dark = button.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let attention = mood.needsAttention || mood.light != .gray
        let image = MascotGlyphRenderer.image(light: mood.light, attention: attention, dark: dark)
        image.isTemplate = !attention
        button.image = image
        let text = model.menuText
        button.title = text.isEmpty ? "" : " \(text)"
        button.setAccessibilityLabel(MenuText.accessibilityLabel(summary: model.summary, limits: model.state.limits, connection: model.connection))
    }
}

/// Matn maydoni (rad etish fikri) ishlashi uchun kalit oyna bo'la oladigan, ilovani faollashtirmaydigan panel.
final class KeyablePanel: NSPanel {
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

/// Panel ildizi: sarlavha va pastki qator qotirilgan, o'rtasi kontentga mos balandlikda (ekrandan oshsa aylanadi).
struct PanelContainer: View {
    let model: AppModel
    let maxBodyHeight: CGFloat
    let onResize: () -> Void
    /// PNG oldindan ko'rish: ImageRenderer ScrollView va AppKit fonini chiza olmaydi.
    var staticRender = false
    @State private var bodyHeight: CGFloat = 200

    var body: some View {
        VStack(spacing: 0) {
            if model.showSettings {
                SettingsView(model: model).padding(10)
            } else {
                PanelHeader(model: model, summary: model.summary)
                Divider().opacity(0.5)
                if staticRender {
                    PanelBody(model: model)
                } else {
                    ScrollView(.vertical) {
                        PanelBody(model: model)
                            .background(GeometryReader { g in Color.clear.preference(key: BodyHeightKey.self, value: g.size.height) })
                    }
                    .scrollIndicators(.automatic)
                    .frame(height: min(bodyHeight, maxBodyHeight))
                }
                Divider().opacity(0.5)
                PanelFooter(model: model)
            }
        }
        .frame(width: StatusPanelController.width)
        .background { if staticRender { Color.clear } else { PanelBackground() } }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
        .onPreferenceChange(BodyHeightKey.self) { h in
            if abs(h - bodyHeight) > 0.5 { bodyHeight = h; onResize() }
        }
        .onChange(of: model.showSettings) { onResize() }
    }
}

private struct BodyHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Tizim "popover" materiali (yarim shaffof, yorug'/qorong'i rejimga mos).
struct PanelBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .popover
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}


