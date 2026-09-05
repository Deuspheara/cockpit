import Hugeicons
import SwiftUI

enum AppIconName: Hashable {
  case home, activity, assistant, settings, bot
  case add, photo, review, send, close, refresh, info, warning
  case chart, connected, recurring, bank, wallet, clock, filter, reset, search
  case sync, arrowUp, arrowDown, arrowRight, attachment, transaction, edit, money

  fileprivate var asset: HugeiconsAsset {
    switch self {
    case .home: Hugeicons.home01
    case .activity: Hugeicons.transactionHistory
    case .assistant: Hugeicons.aiChat01
    case .settings: Hugeicons.settings01
    case .bot: Hugeicons.robot01
    case .add: Hugeicons.add01
    case .photo: Hugeicons.image01
    case .review: Hugeicons.search01
    case .send: Hugeicons.arrowUpRight01
    case .close: Hugeicons.cancel01
    case .refresh: Hugeicons.refresh
    case .info: Hugeicons.informationCircle
    case .warning: Hugeicons.alertCircle
    case .chart: Hugeicons.chartLineData01
    case .connected: Hugeicons.checkmarkCircle01
    case .recurring: Hugeicons.repeatIcon
    case .bank: Hugeicons.bank
    case .wallet: Hugeicons.wallet01
    case .clock: Hugeicons.clock01
    case .filter: Hugeicons.filter
    case .reset: Hugeicons.filterReset
    case .search: Hugeicons.search01
    case .sync: Hugeicons.refresh
    case .arrowUp: Hugeicons.arrowUpRight01
    case .arrowDown: Hugeicons.arrowDownRight01
    case .arrowRight: Hugeicons.arrowRight01
    case .attachment: Hugeicons.attachment
    case .transaction: Hugeicons.transaction
    case .edit: Hugeicons.edit01
    case .money: Hugeicons.money01
    }
  }
}

struct AppIcon: View {
  let name: AppIconName
  var size: CGFloat = 22
  var decorative = true

  var body: some View {
    name.asset.image()
      .resizable()
      .scaledToFit()
      .frame(width: size, height: size)
      .accessibilityHidden(decorative)
  }
}

struct AppEmptyState: View {
  let title: String
  let description: String
  let icon: AppIconName

  var body: some View {
    VStack(spacing: 12) {
      AppIcon(name: icon, size: 38)
        .foregroundStyle(.secondary)
      Text(title)
        .font(.headline)
      Text(description)
        .font(.callout)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 340)
    }
    .frame(maxWidth: .infinity, minHeight: 180)
    .accessibilityElement(children: .combine)
  }
}

enum ProviderBrand: Equatable {
  case hyperliquid, dydx, generic

  static func resolve(sourceType: String) -> ProviderBrand {
    switch sourceType.lowercased() {
    case "hyperliquid": .hyperliquid
    case "dydx": .dydx
    default: .generic
    }
  }
}

struct ProviderLogo: View {
  let sourceType: String
  var size: CGFloat = 36

  var body: some View {
    Group {
      switch ProviderBrand.resolve(sourceType: sourceType) {
      case .hyperliquid:
        Image("BrandHyperliquid")
          .resizable()
          .scaledToFit()
          .padding(7)
          .background(Color(red: 0.07, green: 0.12, blue: 0.13), in: .rect(cornerRadius: 10))
      case .dydx:
        Image("BrandDYDX")
          .resizable()
          .scaledToFit()
          .padding(7)
          .background(Color(red: 0.12, green: 0.10, blue: 0.27), in: .rect(cornerRadius: 10))
      case .generic:
        AppIcon(name: .wallet, size: 22)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .foregroundStyle(.secondary)
          .background(Color.secondary.opacity(0.1), in: .rect(cornerRadius: 10))
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
