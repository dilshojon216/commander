import CommanderContracts
import Foundation

/// Obunachilar hisobi (sof): kanallar va chat sessiyalari uchun ref-count, xabar kimga ketishi. `LiveHub` ichida ishlatiladi.
struct SubscriptionRegistry {
    typealias Continuation = AsyncStream<LiveEvent>.Continuation

    private struct Entry {
        let channels: Set<ClientChannel>
        let chatSession: String?
        let continuation: Continuation
    }

    private var entries: [UUID: Entry] = [:]
    private var channelRefs: [ClientChannel: Int] = [:]
    private var chatRefs: [String: Int] = [:]
    /// Chat sessiyasini birinchi ochgan obunachining `limit`i (qayta ulanishda `chat.open` shu bilan qaytariladi).
    private(set) var chatLimits: [String: Int?] = [:]

    var activeChannels: Set<ClientChannel> { Set(channelRefs.keys) }
    var activeChatSessions: Set<String> { Set(chatRefs.keys) }

    /// Qo'shadi; birinchi marta kerak bo'lgan kanallar va chat sessiyasini qaytaradi (serverga yuborish uchun).
    mutating func add(
        id: UUID, channels: Set<ClientChannel>, chatSession: String?, chatLimit: Int?, continuation: Continuation
    ) -> (newChannels: Set<ClientChannel>, newChat: String?) {
        entries[id] = Entry(channels: channels, chatSession: chatSession, continuation: continuation)
        var added: Set<ClientChannel> = []
        for channel in channels {
            channelRefs[channel, default: 0] += 1
            if channelRefs[channel] == 1 { added.insert(channel) }
        }
        var newChat: String?
        if let session = chatSession {
            chatRefs[session, default: 0] += 1
            if chatRefs[session] == 1 {
                newChat = session
                chatLimits[session] = .some(chatLimit)
            }
        }
        return (added, newChat)
    }

    /// Olib tashlaydi; endi hech kimga kerak bo'lmagan kanallar va chat sessiyasini qaytaradi.
    mutating func remove(id: UUID) -> (droppedChannels: Set<ClientChannel>, droppedChat: String?) {
        guard let entry = entries.removeValue(forKey: id) else { return ([], nil) }
        var dropped: Set<ClientChannel> = []
        for channel in entry.channels {
            channelRefs[channel, default: 1] -= 1
            if channelRefs[channel, default: 0] <= 0 {
                channelRefs[channel] = nil
                dropped.insert(channel)
            }
        }
        var droppedChat: String?
        if let session = entry.chatSession {
            chatRefs[session, default: 1] -= 1
            if chatRefs[session, default: 0] <= 0 {
                chatRefs[session] = nil
                chatLimits[session] = nil
                droppedChat = session
            }
        }
        return (dropped, droppedChat)
    }

    func recipients(for route: LiveRoute) -> [Continuation] {
        switch route {
        case .control: []
        case .broadcast: entries.values.map(\.continuation)
        case .channel(let channel): entries.values.filter { $0.channels.contains(channel) }.map(\.continuation)
        case .chat(let session): entries.values.filter { $0.chatSession == session }.map(\.continuation)
        }
    }

    /// `subscribed` tasdig'i: shu kanallardan birortasiga obuna bo'lganlar snapshot'ni qayta oladi.
    func resyncRecipients(for channels: Set<ClientChannel>) -> [Continuation] {
        entries.values.filter { !$0.channels.isDisjoint(with: channels) }.map(\.continuation)
    }

    var allContinuations: [Continuation] { entries.values.map(\.continuation) }
}
