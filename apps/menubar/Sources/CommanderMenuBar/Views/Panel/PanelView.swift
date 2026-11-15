import CommanderContracts
import DashboardCore
import DashboardUI
import MenuBarCore
import SwiftUI

/// Panel tanasi (aylanadigan qism): umumiy ko'rsatkichlar, ruxsat so'rovlari, limitlar, sessiyalar, mashinalar.
struct PanelBody: View {
    let model: AppModel
    static let maxApprovals = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.loadingToken {
                Banner(text: "Keychain ruxsati kutilmoqda: ochilgan oynada Mac parolini kiritib \"Doim ruxsat berish\"ni bosing", fg: Theme.yellow, bg: Theme.yellowBg, icon: "key.fill")
            } else if !model.isPaired {
                UnpairedView(model: model)
            } else {
                ConnectionBanner(model: model)
                if model.state.lockdown {
                    Banner(text: "Lockdown yoqiq: masofadan faqat rad etish mumkin", fg: Theme.red, bg: Theme.redBg, icon: "lock.fill")
                }
                StatTiles(summary: model.summary)
                approvals
                PanelCard(title: "Limitlar", icon: "gauge.with.dots.needle.67percent") {
                    LimitsCard(limits: model.state.limits)
                }
                SessionsCard(model: model)
                MachinesCard(model: model)
                if model.summary.openAlerts > 0 || model.summary.activeQueue > 0 { StatusStrip(summary: model.summary) }
            }
        }
        .padding(12)
    }

    @ViewBuilder
    private var approvals: some View {
        let list = model.sortedApprovals
        if !list.isEmpty || !model.fading.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                CardTitle(title: "Ruxsat so'rovlari", icon: "hand.raised.fill", tint: Theme.orange, count: list.count)
                ForEach(list.prefix(Self.maxApprovals), id: \.id) { a in ApprovalCardView(approval: a, model: model) }
                if list.count > Self.maxApprovals {
                    MenuRow(title: "Yana \(list.count - Self.maxApprovals) ta so'rov — dashboard'da") { model.openDashboard() }
                }
                ForEach(Array(model.fading.keys.sorted()), id: \.self) { id in
                    if let f = model.fading[id] { FadingApprovalView(approval: f.approval, message: f.message) }
                }
            }
        }
    }
}

struct PanelHeader: View {
    let model: AppModel
    let summary: DashboardSummary

    var body: some View {
        let mood = model.mood
        HStack(spacing: 10) {
            MascotView(pose: mood.pose, light: mood.light, height: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text("Commander").font(.system(size: 15, weight: .bold))
                Text(subtitle).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 6)
            ConnectionIndicator(badge: ConnectionBadge(model.connection))
            Button { model.showSettings = true } label: {
                Image(systemName: "gearshape").font(.system(size: 13, weight: .medium)).frame(width: 26, height: 26)
            }
            .buttonStyle(IconButtonStyle())
            .help("Sozlamalar (⌘,)")
            .keyboardShortcut(",", modifiers: .command)
            .accessibilityLabel("Sozlamalar")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var subtitle: String {
        if !model.isPaired { return "Ulanmagan" }
        if summary.approvals > 0 { return "\(summary.approvals) ta so'rov javob kutmoqda" }
        if summary.waiting > 0 { return "\(summary.waiting) ta sessiya sizni kutmoqda" }
        if summary.working > 0 { return "\(summary.working) ta sessiya ishlayapti" }
        return "Hammasi tinch"
    }
}

/// Pastki qator: asosiy amallar ikonka-tugma ko'rinishida.
struct PanelFooter: View {
    let model: AppModel

    var body: some View {
        HStack(spacing: 4) {
            FooterButton(title: "Dashboard", icon: "rectangle.3.group", shortcut: "d") { model.openDashboard() }
            FooterButton(title: "Brauzerda", icon: "safari") { model.openDashboardInBrowser() }
            Spacer()
            FooterButton(title: "Chiqish", icon: "power", shortcut: "q") { NSApp.terminate(nil) }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }
}
