import CommanderContracts
import DashboardCore
import DashboardUI
import MenuBarCore
import SwiftUI

/// Mashinalar: onlayn holati, sessiyalar soni va resurslar (CPU / xotira / disk).
struct MachinesCard: View {
    let model: AppModel

    var body: some View {
        let machines = model.state.machines.values.sorted {
            $0.online != $1.online ? $0.online : name($0).localizedCaseInsensitiveCompare(name($1)) == .orderedAscending
        }
        if !machines.isEmpty {
            PanelCard(title: "Mashinalar", icon: "server.rack", trailing: "\(machines.filter(\.online).count)/\(machines.count) onlayn") {
                VStack(spacing: 6) {
                    ForEach(machines, id: \.id) { m in MachineRow(machine: m, health: model.state.health[m.id], name: name(m)) }
                }
            }
        }
    }

    private func name(_ m: MachineDto) -> String { m.displayName ?? m.hostname ?? m.slug }
}

struct MachineRow: View {
    let machine: MachineDto
    let health: HealthSummaryItem?
    let name: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                PulsingDot(color: machine.online ? healthColor : Theme.faint)
                Image(systemName: osIcon).font(.system(size: 11)).foregroundStyle(Theme.muted).frame(width: 14)
                Text(name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 4)
                if machine.online {
                    let c = machine.sessions
                    if c.working > 0 { Pill(text: "\(c.working) ishda", fg: Theme.blue, bg: Theme.blueBg, dot: false) }
                    if c.waiting + c.awaitingApproval > 0 { Pill(text: "\(c.waiting + c.awaitingApproval) kutmoqda", fg: Theme.yellow, bg: Theme.yellowBg, dot: false) }
                    if c.working == 0 && c.waiting + c.awaitingApproval == 0 { Text("\(c.open) sessiya").font(.system(size: 11)).foregroundStyle(Theme.faint) }
                } else {
                    Text(offlineText).font(.system(size: 11)).foregroundStyle(Theme.faint)
                }
            }
            if machine.online, let h = health, h.cpuPct != nil || h.memPct != nil || h.diskMaxPct != nil {
                HStack(spacing: 10) {
                    Meter(label: "CPU", pct: h.cpuPct)
                    Meter(label: "RAM", pct: h.memPct)
                    Meter(label: "Disk", pct: h.diskMaxPct)
                }
                .padding(.leading, 33)
            }
        }
        .padding(.vertical, 2)
        .opacity(machine.online ? 1 : 0.6)
        .help(helpText)
        .accessibilityElement(children: .combine)
    }

    private var healthColor: Color {
        switch health?.status {
        case .critical: return Theme.red
        case .warn: return Theme.yellow
        default: return Theme.green
        }
    }

    private var osIcon: String {
        let os = (machine.os ?? "").lowercased()
        if os.contains("darwin") || os.contains("mac") { return "laptopcomputer" }
        if os.contains("win") { return "pc" }
        return "server.rack"
    }

    private var offlineText: String {
        guard let s = machine.lastSeenAt, let d = ContractDates.parse(s) else { return "oflayn" }
        return "oflayn · \(LimitFormat.relative(from: d, to: Date()))"
    }

    private var helpText: String {
        var parts: [String] = []
        if let h = health {
            parts.append("Holat: \(StatusText.health(h.status))")
            if let m = h.diskMaxMount { parts.append("eng to'la disk: \(m)") }
            if h.containersBad > 0 { parts.append("\(h.containersBad)/\(h.containersTotal) konteyner muammoli") }
            if h.failedUnits > 0 { parts.append("\(h.failedUnits) systemd xizmati xato") }
            if h.openIncidents > 0 { parts.append("\(h.openIncidents) ochiq hodisa") }
        }
        if let v = machine.claudeVersion { parts.append("Claude \(v)") }
        return parts.joined(separator: " · ")
    }
}
