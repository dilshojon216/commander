import DashboardCore
import SwiftUI

/// `LoadState` ni bir xil ko'rinishda chizadi: yuklanmoqda / xato (+ qayta urinish) / bo'sh / tayyor ma'lumot.
public struct LoadStateView<Value: Sendable, Content: View>: View {
    private let state: LoadState<Value>
    private let isEmpty: (Value) -> Bool
    private let emptyText: String
    private let retry: (() -> Void)?
    private let content: (Value) -> Content

    public init(
        _ state: LoadState<Value>,
        isEmpty: @escaping (Value) -> Bool = { _ in false },
        emptyText: String = Strings.emptyDefault,
        retry: (() -> Void)? = nil,
        @ViewBuilder content: @escaping (Value) -> Content
    ) {
        self.state = state
        self.isEmpty = isEmpty
        self.emptyText = emptyText
        self.retry = retry
        self.content = content
    }

    public var body: some View {
        switch state {
        case .idle:
            Color.clear
        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(Strings.loading).font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, minHeight: 80)
        case .failed(let message):
            ErrorBanner(message, retry: retry)
        case .loaded(let value):
            if isEmpty(value) {
                Text(emptyText).font(.system(size: 12)).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                content(value)
            }
        }
    }
}
