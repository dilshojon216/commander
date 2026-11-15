import CommanderContracts
import DashboardCore
import DashboardUI
import MenuBarCore
import SwiftUI

/// Bir qarashda: nechta sessiya ishlayapti / kutmoqda / tugadi va mashinalar.
struct StatTiles: View {
    let summary: DashboardSummary

    var body: some View {
        HStack(spacing: 8) {
            tile("\(summary.working)", "Ishlayapti", "bolt.fill", Theme.blue, Theme.blueBg)
            tile("\(summary.waiting + summary.approvals)", "Kutmoqda", "hourglass", Theme.yellow, Theme.yellowBg,
                 highlight: summary.waiting + summary.approvals > 0)
            tile("\(summary.done)", "Tugadi", "checkmark.circle.fill", Theme.green, Theme.greenBg)
            tile("\(summary.onlineMachines)/\(summary.totalMachines)", "Mashina", "desktopcomputer",
                 summary.onlineMachines < summary.totalMachines ? Theme.orange : Theme.muted, Theme.grayBg)
        }
    }

    private func tile(_ value: String, _ label: String, _ icon: String, _ fg: Color, _ bg: Color, highlight: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: icon).font(.system(size: 11, weight: .semibold)).foregroundStyle(fg)
            Text(value).font(.system(size: 20, weight: .bold, design: .rounded)).monospacedDigit().foregroundStyle(Theme.text)
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(label).font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(highlight ? bg : Theme.surface2))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(highlight ? fg.opacity(0.35) : Theme.border.opacity(0.6), lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(value)")
    }
}

/// Salomatlik (eng yomon mashina), ogohlantirishlar va navbat soni.
struct StatusStrip: View {
    let summary: DashboardSummary

    var body: some View {
        HStack(spacing: 6) {
            healthPill
            Spacer(minLength: 2)
            Pill(text: "\(summary.openAlerts) ogohlantirish", fg: summary.openAlerts > 0 ? Theme.yellow : Theme.muted,
                 bg: summary.openAlerts > 0 ? Theme.yellowBg : Theme.grayBg, dot: false)
                .help("Watchdog: uzoq kutayotgan / tokenni tez yoqayotgan / xato aylanishidagi sessiyalar")
            Pill(text: "\(summary.activeQueue) navbatda", fg: Theme.muted, bg: Theme.grayBg, dot: false)
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
    }

    @ViewBuilder
    private var healthPill: some View {
        if let w = summary.worstHealthItem {
            let (fg, bg): (Color, Color) = switch w.status {
            case .critical: (Theme.red, Theme.redBg)
            case .warn: (Theme.yellow, Theme.yellowBg)
            case .ok: (Theme.green, Theme.greenBg)
            default: (Theme.muted, Theme.grayBg)
            }
            Pill(text: w.status == .ok ? "Serverlar joyida" : "\(w.name): \(StatusText.health(w.status))", fg: fg, bg: bg)
                .help(detail(w))
                .accessibilityLabel("Server salomatligi: \(w.name) \(StatusText.health(w.status)). \(detail(w))")
        } else {
            Pill(text: "Salomatlik: —", fg: Theme.muted, bg: Theme.grayBg)
        }
    }

    private func detail(_ w: HealthSummaryItem) -> String {
        var parts: [String] = []
        if let d = w.diskMaxPct { parts.append(String(format: "disk %.0f%%%@", d, w.diskMaxMount.map { " \($0)" } ?? "")) }
        if let m = w.memPct { parts.append(String(format: "xotira %.0f%%", m)) }
        if let c = w.cpuPct { parts.append(String(format: "CPU %.0f%%", c)) }
        if w.containersBad > 0 { parts.append("\(w.containersBad) konteyner muammoli") }
        if w.openIncidents > 0 { parts.append("\(w.openIncidents) ochiq hodisa") }
        return parts.joined(separator: " · ")
    }
}

struct ConnectionBanner: View {
    let model: AppModel

    var body: some View {
        switch model.connection {
        case .reconnecting(let attempt, let retryAt):
            HStack {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let s = max(0, Int(retryAt.timeIntervalSince(ctx.date)))
                    Text("Markaz bilan aloqa yo'q. \(s) s dan keyin qayta urinadi (\(attempt)-urinish). Ma'lumot eskirgan bo'lishi mumkin.")
                        .font(.system(size: 11))
                }
                Spacer()
                Button("Hozir") { model.reconnectNow() }.buttonStyle(CardButton(kind: .plain))
            }
            .padding(8).foregroundStyle(Theme.yellow)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.yellowBg))
        case .unauthorized(let reason):
            HStack {
                Text(reason).font(.system(size: 11))
                Spacer()
                Button("Qayta ulash…") { model.showPairing() }.buttonStyle(CardButton(kind: .plain))
            }
            .padding(8).foregroundStyle(Theme.red)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.redBg))
        default:
            if let e = model.lastError {
                Banner(text: e, fg: Theme.yellow, bg: Theme.yellowBg, icon: "exclamationmark.triangle")
            }
        }
    }
}

struct UnpairedView: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 10) {
            MascotView(pose: .mudrayapti, light: .gray, height: 80)
            Text("Commander hali ulanmagan").font(.system(size: 13, weight: .semibold))
            Text("Center'da bir martalik kod yarating va shu Mac'ni ulang.")
                .font(.system(size: 12)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            Button("Ulash…") { model.showPairing() }.buttonStyle(CardButton(kind: .ok))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
    }
}
