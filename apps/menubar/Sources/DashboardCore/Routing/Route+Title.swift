import Foundation

extension Route {
    /// Oyna sarlavhasi (o'zbekcha): ro'yxat sahifalarida bo'lim nomi, tafsilot sahifalarida obyekt nomi.
    public var title: String {
        switch self {
        case .session: "Sessiya"
        case .project: "Loyiha"
        case .projectWork: "Loyiha ish maydoni"
        case .machine: "Mashina"
        case .addMachine: "Mashina qo'shish"
        case .report: "Hisobot"
        case .scan: "Xavfsizlik tekshiruvi"
        case .helpDoc: "Yo'riqnoma"
        default: section.title
        }
    }
}
