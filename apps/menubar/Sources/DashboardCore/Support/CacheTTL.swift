import Foundation

/// `ResponseCache` yashash muddatlari (docs/NATIVE-DASHBOARD.md, 3.2): ma'lumot turiga qarab.
public enum CacheTTL {
    /// Ro'yxatlar (sessiyalar, mashinalar, ogohlantirishlar): 30 soniya.
    public static let list: TimeInterval = 30
    /// Sozlamalar va kam o'zgaradigan ma'lumot: 5 daqiqa.
    public static let settings: TimeInterval = 300
}
