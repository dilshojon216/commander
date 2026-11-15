import Foundation
import MenuBarCore

/// Markaz bilan aloqa belgisi: matn va ohang. Rangni `DashboardUI` ohangdan tanlaydi (Core'da rang yo'q).
public struct ConnectionBadge: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case good, neutral, warning, danger }

    public let title: String
    public let tone: Tone
    /// Jonli ulanishda nuqta yonib-o'chib turadi.
    public let pulsing: Bool

    public init(_ status: ConnectionStatus) {
        switch status {
        case .live: self.init(title: "Jonli", tone: .good, pulsing: true)
        case .connecting: self.init(title: "Ulanmoqda…", tone: .neutral, pulsing: false)
        case .reconnecting: self.init(title: "Qayta ulanmoqda…", tone: .warning, pulsing: false)
        case .unauthorized: self.init(title: "Token rad etildi", tone: .danger, pulsing: false)
        case .unpaired: self.init(title: "Ulanmagan", tone: .neutral, pulsing: false)
        }
    }

    private init(title: String, tone: Tone, pulsing: Bool) {
        self.title = title
        self.tone = tone
        self.pulsing = pulsing
    }
}
