import Foundation

enum FinanceFormat {
  static func amount(_ value: Amount, currency: String, locale: Locale = .current) -> String {
    value.decimal.formatted(.currency(code: currency).locale(locale))
  }
  static func quantity(_ value: Amount, locale: Locale = .current) -> String {
    value.decimal.formatted(.number.precision(.fractionLength(0...8)).locale(locale))
  }
  static func percent(_ value: Amount) -> String {
    (value.decimal / 100).formatted(.percent.precision(.fractionLength(0...2)))
  }
}
