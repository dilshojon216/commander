import Foundation

/// Davriy so'rov oqimi (WS'da bo'lmagan manbalar: log, deploy chiqishi). Natija ham xato ham oqimga keladi, xato to'xtatmaydi;
/// oqim bekor qilinganda (ekran yopilsa) so'rovlar to'xtaydi.
public struct PollingStream<Element: Sendable>: Sendable {
    public typealias Fetch = @Sendable () async throws(APIError) -> Element

    private let interval: TimeInterval
    private let sleeper: any Sleeping
    private let fetch: Fetch

    public init(interval: TimeInterval, sleeper: any Sleeping = TaskSleeper(), fetch: @escaping Fetch) {
        self.interval = interval
        self.sleeper = sleeper
        self.fetch = fetch
    }

    public func stream() -> AsyncStream<Result<Element, APIError>> {
        let interval = interval, sleeper = sleeper, fetch = fetch
        return AsyncStream { continuation in
            let task = Task {
                while !Task.isCancelled {
                    continuation.yield(await Self.run(fetch))
                    do { try await sleeper.sleep(for: interval) } catch { break }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func run(_ fetch: Fetch) async -> Result<Element, APIError> {
        do throws(APIError) {
            return .success(try await fetch())
        } catch {
            return .failure(error)
        }
    }
}
