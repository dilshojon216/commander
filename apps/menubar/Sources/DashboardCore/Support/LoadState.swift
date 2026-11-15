import Foundation

/// Ekran ma'lumotining yuklanish holati: har ekran bir xil holatlarni (yuklanmoqda / bo'sh / xato) ko'rsatadi.
public enum LoadState<Value: Sendable>: Sendable {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    public var value: Value? {
        if case .loaded(let value) = self { return value }
        return nil
    }

    public var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }

    public var errorMessage: String? {
        if case .failed(let message) = self { return message }
        return nil
    }
}

extension LoadState: Equatable where Value: Equatable {}
