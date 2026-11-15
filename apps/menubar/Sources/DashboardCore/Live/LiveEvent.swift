import CommanderContracts
import Foundation
import MenuBarCore

/// `LiveHub` obunachisiga keladigan hodisa.
public enum LiveEvent: Sendable {
    case message(ServerToClientMessage)
    /// Aloqa holati o'zgardi (obuna paytida joriy holat ham keladi).
    case status(ConnectionStatus)
    /// Obuna tasdiqlandi (`subscribed`, qayta ulanishdan keyin ham): REST snapshot qayta olinadi (PLAN §8: avval subscribe, keyin snapshot).
    case resync
}

/// Server xabari kimga yetkaziladi.
enum LiveRoute: Equatable {
    case channel(ClientChannel)
    /// Hamma obunachiga (`auth.ok`, `lockdown.updated`, `error`).
    case broadcast
    case chat(sessionId: String)
    /// Hub o'zi ishlaydi (`subscribed`, `pong`, `auth.error`) yoki noma'lum tur: obunachiga yetmaydi.
    case control
}

extension ServerToClientMessage {
    /// Xabar turi -> kanal xaritasi (center `RealtimeHubService.broadcast` bilan bir xil).
    var route: LiveRoute {
        switch self {
        case .sessionUpdated: .channel(.sessions)
        case .machineUpdated: .channel(.machines)
        case .usageTick: .channel(.usage)
        case .limitsUpdated: .channel(.limits)
        case .approvalCreated, .approvalResolved: .channel(.approvals)
        case .commandUpdated: .channel(.commands)
        case .projectUpdated: .channel(.projects)
        case .messageCreated, .messageUpdated: .channel(.messages)
        case .machineHealth: .channel(.health)
        case .queueUpdated: .channel(.queue)
        case .alertCreated, .alertUpdated: .channel(.alerts)
        case .orchestrationUpdated: .channel(.orchestrations)
        case .authOk, .lockdownUpdated, .error: .broadcast
        case .chatItems(let message): .chat(sessionId: message.payload.sessionId)
        case .chatState(let message): .chat(sessionId: message.payload.sessionId)
        case .subscribed, .authError, .pong, .unknown: .control
        }
    }
}
