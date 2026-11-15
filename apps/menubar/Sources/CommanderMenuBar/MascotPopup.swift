import AppKit
import MenuBarCore
import SwiftUI

/// "Burchakdan chiqish": menu-bar ostida, ekranning o'ng yuqori burchagida chegarasiz suzuvchi panel.
/// O'ngdan sirpanib chiqadi (Reduce Motion'da faqat paydo bo'ladi), o'zi yashirinadi, bosilsa panel ochiladi.
@MainActor
final class MascotPopupController {
    private weak var model: AppModel?
    private var panel: NSPanel?
    private var current: PopupSpec?
    private var hideTask: Task<Void, Never>?
    private let size = NSSize(width: 360, height: 128)

    init(model: AppModel) { self.model = model }

    func show(_ spec: PopupSpec) {
        // Ruxsat so'rovi ustuvor: ochiq approval pop-up'ini past ustuvorlikdagi hodisa almashtirmaydi.
        if let cur = current, cur.pose == .ruxsat, spec.pose != .ruxsat, panel?.isVisible == true { return }
        current = spec
        let panel = self.panel ?? makePanel()
        self.panel = panel
        let root = MascotPopupView(spec: spec,
                                   onOpen: { [weak self] in
                                       // Sahifa bo'lsa dashboard oynasi, aks holda panel.
                                       if let t = spec.target { self?.model?.openDashboard(t) } else { self?.model?.openPanel() }
                                   },
                                   onClose: { [weak self] in self?.hide(animated: true) })
        panel.contentView = NSHostingView(rootView: root)

        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let vf = screen.visibleFrame
        let final = NSRect(x: vf.maxX - size.width - 12, y: vf.maxY - size.height - 8, width: size.width, height: size.height)
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if !panel.isVisible {
            if reduceMotion {
                panel.setFrame(final, display: true)
                panel.alphaValue = 0
                panel.orderFrontRegardless()
                NSAnimationContext.runAnimationGroup { $0.duration = 0.2; panel.animator().alphaValue = 1 }
            } else {
                panel.setFrame(final.offsetBy(dx: size.width + 24, dy: 0), display: true)
                panel.alphaValue = 1
                panel.orderFrontRegardless()
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.45
                    ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 1.3, 0.4, 1)
                    panel.animator().setFrame(final, display: true)
                }
            }
        } else {
            panel.setFrame(final, display: true)
        }
        NSAccessibility.post(element: panel, notification: .announcementRequested,
                             userInfo: [.announcement: "\(spec.title). \(spec.text)", .priority: NSAccessibilityPriorityLevel.high.rawValue])

        hideTask?.cancel()
        let delay = spec.autoHide ?? PopupSpec.maxVisible
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.hide(animated: true)
        }
    }

    func dismiss(approvalId: String) {
        guard current?.approvalId == approvalId else { return }
        hide(animated: true)
    }

    func dismissAll() { hide(animated: false) }

    private func hide(animated: Bool) {
        hideTask?.cancel()
        current = nil
        guard let panel, panel.isVisible else { return }
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if !animated {
            panel.orderOut(nil)
            return
        }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.3
            if reduceMotion {
                panel.animator().alphaValue = 0
            } else {
                panel.animator().setFrame(panel.frame.offsetBy(dx: size.width + 24, dy: 0), display: true)
            }
        }, completionHandler: {
            Task { @MainActor in
                if self.current == nil { panel.orderOut(nil) }
                panel.alphaValue = 1
            }
        })
    }

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        p.isFloatingPanel = true
        p.level = .statusBar
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = false
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.isReleasedWhenClosed = false
        return p
    }
}

struct MascotPopupView: View {
    let spec: PopupSpec
    let onOpen: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Circle().fill(Theme.light(spec.light)).frame(width: 8, height: 8).accessibilityHidden(true)
                    Text(spec.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                }
                Text(spec.text).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(2)
                HStack(spacing: 6) {
                    Button("Yopish", action: onClose)
                        .buttonStyle(PopupButtonStyle(fill: nil))
                        .keyboardShortcut(.cancelAction)
                    Button(spec.approvalId != nil ? "Ko'rish" : "Ochish", action: onOpen)
                        .buttonStyle(PopupButtonStyle(fill: Theme.light(spec.light)))
                }
                .padding(.top, 6)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(width: 250, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(.regularMaterial))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border))
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpen)

            MascotView(pose: spec.pose, light: spec.light, height: 96)
                .onTapGesture(perform: onOpen)
        }
        .padding(4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Commander ogohlantirishi: \(spec.title)")
    }
}

struct PopupButtonStyle: ButtonStyle {
    let fill: Color?
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: fill == nil ? .medium : .semibold))
            .frame(maxWidth: .infinity, minHeight: 26)
            .foregroundStyle(fill == nil ? Theme.text : Color(hex: 0x0B0D10))
            .background(RoundedRectangle(cornerRadius: 6).fill(fill ?? Theme.surface2))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(fill == nil ? Theme.border : .clear))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}
