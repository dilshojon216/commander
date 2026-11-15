import DashboardCore
import MenuBarCore
import SwiftUI

/// Umumiy komponentlar galereyasi: vizual tekshiruv uchun (`--render-previews` PNG'ga chizadi). Ma'lumot namunaviy.
public struct ComponentGallery: View {
    public init() {}

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            section("Holat pill'lari") {
                HStack {
                    StatusPill(kind: .working, text: "Ishlayapti")
                    StatusPill(kind: .waiting, text: "Kutmoqda")
                    StatusPill(kind: .approval, text: "Ruxsat")
                    StatusPill(kind: .done, text: "Tugadi")
                    StatusPill(kind: .idle, text: "Bo'sh")
                }
            }
            section("Aloqa belgisi") {
                HStack {
                    ConnectionIndicator(badge: ConnectionBadge(.live))
                    ConnectionIndicator(badge: ConnectionBadge(.connecting))
                    ConnectionIndicator(badge: ConnectionBadge(.reconnecting(attempt: 1, retryAt: .distantFuture)))
                    ConnectionIndicator(badge: ConnectionBadge(.unauthorized(reason: "")))
                    ConnectionIndicator(badge: ConnectionBadge(.unpaired))
                }
            }
            section("Xabarlar") {
                VStack(spacing: 6) {
                    LockdownBanner()
                    ErrorBanner("Markaz javob bermadi", retry: {})
                    Banner(text: "Ma'lumot eskirgan bo'lishi mumkin", fg: Theme.yellow, bg: Theme.yellowBg, icon: "clock")
                }
            }
            section("Limit chiziqlari (rasmiy / taxmin) va o'lchagichlar") {
                VStack(alignment: .leading, spacing: 8) {
                    LimitBar(pct: 42, color: Theme.blue, estimate: false)
                    LimitBar(pct: 42, color: Theme.blue, estimate: true)
                    HStack(spacing: 12) {
                        Meter(label: "CPU", pct: 35)
                        Meter(label: "RAM", pct: 78)
                        Meter(label: "DISK", pct: 94)
                        Meter(label: "GPU", pct: nil)
                    }
                }
            }
            section("Yuklanish holatlari") {
                VStack(spacing: 6) {
                    LoadStateView(LoadState<[Int]>.failed("Aloqa yo'q"), retry: {}) { _ in Text("") }
                    LoadStateView(LoadState<[Int]>.loaded([]), isEmpty: { $0.isEmpty }, emptyText: "Sessiyalar yo'q") { _ in Text("") }
                    LoadStateView(LoadState<[Int]>.loaded([1, 2, 3])) { items in Text("\(items.count) ta element") }
                }
            }
            section("Tugmalar") {
                HStack {
                    ConfirmButton("O'chirish", role: .destructive) {}
                    ElevatedButton("Ruxsat berish", authorize: { true }, action: {})
                }
            }
        }
        .padding(Layout.contentPadding)
        .frame(width: 560)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(title)
            content()
        }
    }
}
