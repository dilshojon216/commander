// ESKIRMASIN: bu fayl scripts/gen-elevation-rules.mjs bilan generatsiya qilinadi (manba: apps/dashboard/lib/proxy-rules.ts).
// Qo'lda tahrirlamang; qoidani web'da o'zgartirib, skriptni qayta ishga tushiring.

enum GeneratedElevationRules {
    /// `POST /approvals/:id/decision` — ruxsat qarori (`decision` elevation).
    static let decision = #"^approvals\/([0-9a-fA-F-]{36})\/decision$"#
    static let queueItem = #"^queue\/[0-9a-fA-F-]{36}$"#
    static let templateItem = #"^templates\/[0-9a-fA-F-]{36}$"#
    /// Elevation talab QILMAYDIGAN o'zgartiruvchi yo'llar (17 ta); qolgan hammasi fail-closed `required`.
    static let exempt: [String] = [
        #"^commands\/[0-9a-fA-F-]{36}\/cancel$"#,
        #"^queue\/[0-9a-fA-F-]{36}\/cancel$"#,
        #"^orchestrations\/[0-9a-fA-F-]{36}\/cancel$"#,
        #"^approval-rules\/[0-9]{1,18}$"#,
        #"^alerts\/[0-9a-fA-F-]{36}\/dismiss$"#,
        #"^templates\/[0-9a-fA-F-]{36}\/render$"#,
        #"^projects\/[0-9a-fA-F-]{36}\/(diff|ci\/refresh|refresh)$"#,
        #"^sessions\/[0-9a-fA-F-]{36}\/diff$"#,
        #"^projects\/[0-9a-fA-F-]{36}\/tasks\/(?:[a-z0-9][a-z0-9._~-]{0,127}(?::|%3A))?[a-z0-9][a-z0-9._-]{0,31}\/board$"#,
        #"^templates$"#,
        #"^assistant\/ask$"#,
        #"^machines\/[0-9a-fA-F-]{36}\/logs$"#,
        #"^logs\/[0-9a-fA-F-]{36}$"#,
        #"^projects\/[0-9a-fA-F-]{36}\/scan$"#,
        #"^projects\/[0-9a-fA-F-]{36}\/deploy\/inspect$"#,
        #"^projects\/[0-9a-fA-F-]{36}\/checkpoints$"#,
        #"^projects\/[0-9a-fA-F-]{36}\/checkpoints\/list$"#,
    ]
}
