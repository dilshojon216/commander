import CommanderContracts
import DashboardCore
import DashboardUI
import MenuBarCore
import SwiftUI

/// Sessiyalar loyiha bo'yicha. Faol (ishlayotgan/kutayotgan) loyihalar ochiq turadi; bosilsa yig'iladi/ochiladi.
struct SessionsCard: View {
    let model: AppModel
    static let maxGroups = 8
    static let maxSessionsPerGroup = 6
    @State private var toggled: Set<String> = []

    var body: some View {
        let groups = model.projectGroups
        let total = groups.reduce(0) { $0 + $1.sessions.count }
        PanelCard(title: "Sessiyalar", icon: "terminal", trailing: total > 0 ? "\(total) ta · \(groups.count) loyiha" : nil) {
            if groups.isEmpty {
                Text(model.state.hasSnapshot ? "Faol sessiya yo'q" : "Yuklanmoqda…")
                    .font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.vertical, 2)
            }
            VStack(spacing: 2) {
                ForEach(groups.prefix(Self.maxGroups)) { g in
                    let open = isOpen(g)
                    Button {
                        if toggled.contains(g.name) { toggled.remove(g.name) } else { toggled.insert(g.name) }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint).frame(width: 10)
                                .rotationEffect(.degrees(open ? 90 : 0))
                            Image(systemName: "folder.fill").font(.system(size: 11)).foregroundStyle(Theme.blue.opacity(0.8))
                            Text(g.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                            Spacer(minLength: 4)
                            ForEach(g.counts, id: \.self) { c in
                                let k = StatusKind.of(c.status)
                                let colors = Theme.status(k)
                                Pill(text: "\(c.count) \(StatusText.label(c.status))", fg: colors.fg, bg: colors.bg, pulsing: k == .working)
                            }
                        }
                        .padding(.horizontal, 6).padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(RowButtonStyle())
                    .accessibilityLabel("\(g.name): " + g.counts.map { "\($0.count) \(StatusText.label($0.status))" }.joined(separator: ", "))
                    .accessibilityHint(open ? "Yopish" : "Sessiyalarni ko'rsatish")
                    if open {
                        VStack(spacing: 0) {
                            ForEach(g.sessions.prefix(Self.maxSessionsPerGroup), id: \.id) { s in SessionRow(session: s) }
                        }
                        .padding(.bottom, 4)
                    }
                }
            }
            if groups.count > Self.maxGroups {
                MenuRow(title: "Yana \(groups.count - Self.maxGroups) loyiha — dashboard'da") { model.openDashboard() }
            }
        }
    }

    /// Sukut: ishlayotgan/kutayotgan sessiyasi bor loyiha ochiq. Foydalanuvchi bosgani buni teskari qiladi.
    private func isOpen(_ g: ProjectGroup) -> Bool {
        let active = g.sessions.contains { [.working, .waiting, .awaitingApproval].contains($0.status) }
        return active != toggled.contains(g.name)
    }
}

enum StatusKind {
    static func of(_ s: SessionStatus) -> SessionStatusKind {
        switch s {
        case .working: return .working
        case .waiting: return .waiting
        case .awaitingApproval: return .approval
        case .done: return .done
        case .idle: return .idle
        default: return .other
        }
    }
}

struct SessionRow: View {
    let session: SessionDto

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            let k = StatusKind.of(session.status)
            PulsingDot(color: Theme.status(k).fg, pulsing: k == .working).padding(.top, 4)
                .help(StatusText.label(session.status))
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    if session.staleSince != nil {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.yellow).font(.system(size: 9))
                            .accessibilityLabel("Aloqa yo'q")
                    }
                    Text(session.name ?? String(session.claudeSessionId.prefix(8))).font(Theme.mono).lineLimit(1)
                    Text("· \(session.machineName)").font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                }
                if let m = session.message, !m.isEmpty {
                    Text(m).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(2)
                }
            }
            Spacer()
            TimelineView(.periodic(from: .now, by: 30)) { ctx in
                Text(ContractDates.parse(session.statusSince).map { LimitFormat.relative(from: $0, to: ctx.date) } ?? "")
                    .font(.system(size: 10)).foregroundStyle(Theme.faint)
            }
        }
        .padding(.leading, 24).padding(.trailing, 6).padding(.vertical, 3)
        .opacity(session.staleSince != nil ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }
}
