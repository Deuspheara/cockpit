import Charts
import SwiftUI

struct PortfolioValueChart: View {
  let dashboard: PortfolioDashboard
  @Binding var range: PortfolioRange
  let compactEmptyHistory: Bool
  @MotionPreference private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var selectedDate: Date?
  @State private var changeExplanationPresented = false

  init(dashboard: PortfolioDashboard, range: Binding<PortfolioRange>, initialSelection: Date? = nil, compactEmptyHistory: Bool = false)
  {
    self.dashboard = dashboard
    self.compactEmptyHistory = compactEmptyHistory
    _range = range
    _selectedDate = State(initialValue: initialSelection)
  }

  private var selected: ValuationPoint? {
    guard let date = selectedDate else { return nil }
    return dashboard.chart.min {
      abs($0.at.timeIntervalSince(date)) < abs($1.at.timeIntervalSince(date))
    }
  }

  var body: some View {
    let selected = self.selected
    VStack(alignment: .leading, spacing: 12) {
      Text(FinanceFormat.amount(selected?.value ?? dashboard.value, currency: dashboard.currency))
        .font(.system(.largeTitle, design: .rounded, weight: .semibold))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .accessibilityLabel(dashboard.complete ? "Portfolio value" : "Known subtotal")
        .accessibilityValue(
          FinanceFormat.amount(selected?.value ?? dashboard.value, currency: dashboard.currency))

      if !compactEmptyHistory || !dashboard.chart.isEmpty {
      ZStack(alignment: .leading) {
        Text(
          (selected?.sourceAt ?? selected?.at ?? dashboard.asOf).formatted(
            date: .abbreviated, time: .shortened)
        )
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .opacity(selected == nil ? 0 : 1)
        .accessibilityHidden(selected == nil)
        Group {
          if let change = dashboard.absoluteChange, let percent = dashboard.percentChange {
            HStack(spacing: 8) {
              AppIcon(name: change.decimal >= 0 ? .arrowUp : .arrowDown, size: 17)
              Text(
                "\(FinanceFormat.amount(change, currency: dashboard.currency)) · \(FinanceFormat.percent(percent))"
              )
              Button {
                changeExplanationPresented.toggle()
              } label: {
                AppIcon(name: .info, size: 17)
                  .frame(width: 44, height: 44)
                  .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .foregroundStyle(.secondary)
              .accessibilityLabel("About value change")
              .accessibilityHint("Explains how deposits and withdrawals affect this value")
              .popover(isPresented: $changeExplanationPresented) {
                Text(
                  "Value change includes deposits and withdrawals; it is not investment performance."
                )
                .font(.callout)
                .padding()
                .presentationCompactAdaptation(.popover)
              }
            }
            .font(.subheadline)
            .foregroundStyle(change.decimal >= 0 ? Color.green : Color.red)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
              "Value change for \(dashboard.range.title): \(FinanceFormat.amount(change, currency: dashboard.currency)), \(FinanceFormat.percent(percent))"
            )
          } else {
            Text("Period change unavailable")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .opacity(selected == nil ? 1 : 0)
        .allowsHitTesting(selected == nil)
        .accessibilityHidden(selected != nil)
      }
      .frame(minHeight: 44, alignment: .leading)
      .animation(AppMotion.fade(reduceMotion), value: selected != nil)
      .accessibilityIdentifier("chart-subtitle")
      }

      if !dashboard.complete {
        HStack(spacing: 6) {
          AppIcon(name: .warning, size: 16)
          Text(compactEmptyHistory ? "Partial value · some prices or conversions are missing" : "Known subtotal · some prices or currency conversions are missing")
        }
        .font(.caption)
        .foregroundStyle(compactEmptyHistory ? Color.secondary : Color.orange)
        .accessibilityElement(children: .combine)
      }

      Group {
        if dashboard.chart.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            Text(compactEmptyHistory ? "History is building" : "No history for this period")
              .font(.subheadline.weight(.medium))
            if compactEmptyHistory {
              Text("No recorded values in this period yet.").font(.caption)
            }
          }
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: compactEmptyHistory ? .leading : .center)
        } else {
          Chart {
            ForEach(dashboard.chart) { point in
              if dashboard.chart.count == 1 {
                PointMark(
                  x: .value("Date", point.at),
                  y: .value("Value", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
                )
                .foregroundStyle(Color.accentColor)
                .symbolSize(45)
              }
              LineMark(
                x: .value("Date", point.at),
                y: .value("Value", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
              )
              .interpolationMethod(.monotone)
              .foregroundStyle(Color.accentColor)
              .lineStyle(StrokeStyle(lineWidth: 2))
              .accessibilityLabel(point.at.formatted(date: .abbreviated, time: .omitted))
              .accessibilityValue(FinanceFormat.amount(point.value, currency: dashboard.currency))
            }
            if let point = selected {
              RuleMark(x: .value("Selected date", point.at))
                .foregroundStyle(.secondary.opacity(0.4))
              PointMark(
                x: .value("Date", point.at),
                y: .value("Value", NSDecimalNumber(decimal: point.value.decimal).doubleValue)
              )
              .foregroundStyle(Color.accentColor)
            }
          }
          .chartYScale(domain: .automatic(includesZero: false))
          .chartYAxis(.hidden)
          .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: typeSize.isAccessibilitySize ? 2 : 3))
          }
          .chartXSelection(value: $selectedDate)
          .frame(height: 200)
          .accessibilityLabel("Historical portfolio value")
        }

      }
      .frame(height: compactEmptyHistory && dashboard.chart.isEmpty ? nil : 200)
      .frame(minHeight: compactEmptyHistory && dashboard.chart.isEmpty ? 64 : nil)
      .modifier(DatasetTransition(key: "\(dashboard.scope.rawValue)-\(dashboard.range.rawValue)"))
      .accessibilityIdentifier("portfolio-chart-plot")

      ChartRangePicker(selection: $range)
    }
    .onChange(of: range) { selectedDate = nil }
    .onChange(of: dashboard.scope) { selectedDate = nil }
  }
}

struct ChartRangePicker: View {
  @Binding var selection: PortfolioRange
  @Namespace private var indicator
  @MotionPreference private var reduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    if typeSize.isAccessibilitySize {
      ScrollViewReader { scroll in
        ScrollView(.horizontal) { buttons }
          .scrollIndicators(.hidden)
          .onAppear { scroll.scrollTo(selection, anchor: .center) }
          .onChange(of: selection) {
            withAnimation(AppMotion.selection(reduceMotion)) {
              scroll.scrollTo(selection, anchor: .center)
            }
          }
      }
    } else {
      buttons
    }
  }
  private var buttons: some View {
    HStack(spacing: 0) {
      ForEach(PortfolioRange.allCases, id: \.self) { range in
        Button {
          withAnimation(AppMotion.selection(reduceMotion)) { selection = range }
        } label: {
          Text(range.title)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, typeSize.isAccessibilitySize ? 14 : 0)
            .frame(maxWidth: typeSize.isAccessibilitySize ? nil : .infinity, minHeight: 44)
            .contentShape(Rectangle())
            .background {
              if selection == range {
                Capsule().fill(Color.accentColor.opacity(0.12))
                  .matchedGeometryEffect(id: "range", in: indicator)
              }
            }
        }
        .buttonStyle(.plain)
        .id(range)
        .accessibilityAddTraits(selection == range ? .isSelected : [])
      }
    }
  }
}

struct PortfolioScopePicker: View {
  @Binding var selection: PortfolioScope
  @Namespace private var indicator
  @MotionPreference private var reduceMotion
  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 6) {
        ForEach(PortfolioScope.allCases, id: \.self) { scope in
          Button {
            withAnimation(AppMotion.selection(reduceMotion)) { selection = scope }
          } label: {
            Text(scope.title)
              .font(.subheadline.weight(.medium))
              .padding(.horizontal, 15)
              .frame(minHeight: 44)
              .contentShape(Rectangle())
              .background {
                if selection == scope {
                  Capsule().fill(Color.primary.opacity(0.07))
                    .matchedGeometryEffect(id: "scope", in: indicator)
                }
              }
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(selection == scope ? .isSelected : [])
        }
      }
    }
    .scrollIndicators(.hidden)
  }
}
