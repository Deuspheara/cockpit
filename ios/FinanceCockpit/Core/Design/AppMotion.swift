import SwiftUI

@propertyWrapper struct MotionPreference: DynamicProperty {
  @Environment(\.accessibilityReduceMotion) private var systemValue
  var wrappedValue: Bool {
    #if DEBUG
      let arguments = ProcessInfo.processInfo.arguments
      if arguments.contains("--ui-fixtures"), arguments.contains("--reduce-motion") { return true }
    #endif
    return systemValue
  }
}

enum AppMotion {
  static func fade(_ reduceMotion: Bool) -> Animation {
    .easeInOut(duration: reduceMotion ? 0.1 : 0.25)
  }
  static func selection(_ reduceMotion: Bool) -> Animation? {
    reduceMotion ? nil : .smooth(duration: 0.25, extraBounce: 0)
  }
}

/// Identity changes only for a new dataset, never for a drag update.
struct DatasetTransition<Key: Equatable & Hashable>: ViewModifier {
  let key: Key
  @MotionPreference private var reduceMotion
  func body(content: Content) -> some View {
    ZStack { content.id(key).transition(.opacity) }
      .animation(AppMotion.fade(reduceMotion), value: key)
  }
}
