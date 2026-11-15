import AppKit
import DashboardUI
import MenuBarCore
import SwiftUI
import WebKit

/// Klaviatura yorliqlarini asosiy menyudan oldin ushlash uchun.
final class DashboardWindow: NSWindow {
    var keyHandler: ((NSEvent) -> Bool)?
    var clickProbe: ((NSEvent) -> Void)?

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown {
            DebugLog.write("dash click key=\(isKeyWindow) active=\(NSApp.isActive) loc=\(Int(event.locationInWindow.x)),\(Int(event.locationInWindow.y))")
            clickProbe?(event)
        }
        super.sendEvent(event)
    }

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
