import CommanderContracts
import Foundation

extension ChatItem {
    /// Element id'si (yangilanishda o'rniga qo'yish va takrorni tashlash uchun). Noma'lum turda xom JSON'dagi `id`.
    public var itemId: String? {
        switch self {
        case .user(let item): item.id
        case .assistant(let item): item.id
        case .thinking(let item): item.id
        case .toolUse(let item): item.id
        case .toolResult(let item): item.id
        case .notice(let item): item.id
        case .usage(let item): item.id
        case .unknown(_, let raw): raw["id"]?.stringValue
        }
    }
}

/// Serverdan kelgan chat bo'lagi (`chat.items`).
public struct ChatBatch: Sendable, Equatable {
    public let sessionId: String
    public let items: [ChatItem]
    /// `true`: to'liq qayta yuklash (ochilish/qayta ulanish): mavjud ro'yxat almashtiriladi.
    public let replace: Bool
    /// `true`: eski sahifa (ro'yxat boshiga qo'shiladi).
    public let older: Bool
    /// Eskiroq sahifa kursori; `nil` = boshiga yetildi.
    public let cursor: String?

    init(_ payload: ChatItemsToClientPayload) {
        sessionId = payload.sessionId
        items = payload.items
        replace = payload.replace ?? false
        older = payload.older ?? false
        cursor = payload.cursor
    }
}

/// Chat ro'yxatining sof reduktori: ochilish, qo'shimchalar va eski sahifalar. Elementlar id bo'yicha takrorlanmaydi.
public struct ChatTimeline: Equatable, Sendable {
    public private(set) var items: [ChatItem] = []
    /// Keyingi (eskiroq) sahifa kursori; `nil` bo'lsa yuklanadigan eski qism yo'q.
    public private(set) var olderCursor: String?
    public private(set) var loaded = false

    public init() {}

    public var canLoadOlder: Bool { olderCursor != nil }

    public mutating func apply(_ batch: ChatBatch) {
        if batch.replace {
            items = Self.unique(batch.items)
            olderCursor = batch.cursor
            loaded = true
        } else if batch.older {
            let known = Set(items.compactMap(\.itemId))
            let fresh = Self.unique(batch.items).filter { $0.itemId.map { !known.contains($0) } ?? true }
            items = fresh + items
            olderCursor = batch.cursor
        } else {
            for item in batch.items { append(item) }
        }
    }

    /// Mavjud id bo'lsa o'rniga qo'yadi (element yangilangan), aks holda oxiriga qo'shadi.
    private mutating func append(_ item: ChatItem) {
        if let id = item.itemId, let index = items.firstIndex(where: { $0.itemId == id }) {
            items[index] = item
        } else {
            items.append(item)
        }
    }

    private static func unique(_ list: [ChatItem]) -> [ChatItem] {
        var seen = Set<String>()
        return list.filter { item in
            guard let id = item.itemId else { return true }
            return seen.insert(id).inserted
        }
    }
}
