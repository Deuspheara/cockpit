import XCTest

@MainActor final class CSVImportUITests: XCTestCase {
  private func open(_ args: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-fixtures"] + args
    app.launch()
    XCTAssertTrue(app.buttons["1M"].waitForExistence(timeout: 15))
    app.navigationBars["Portfolio"].buttons["Add"].tap()
    app.buttons["Add account"].tap()
    let manual = app.buttons.containing(.staticText, identifier: "Manual import").firstMatch
    XCTAssertTrue(manual.waitForExistence(timeout: 5))
    manual.tap()
    return app
  }
  func testNativePickerPresentation() {
    let app = open()
    let choose = app.buttons["csv-choose-file"]
    XCTAssertTrue(choose.waitForExistence(timeout: 5))
    choose.tap()
    XCTAssertTrue(
      app.buttons["Browse"].waitForExistence(timeout: 8) || app.navigationBars["Browse"].exists
        || app.buttons["Cancel"].exists)
  }
  func testPreviewConfirmSuccess() {
    let app = open(["--csv-preview"])
    let confirm = app.buttons["csv-confirm"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 8))
    confirm.tap()
    XCTAssertTrue(app.buttons["csv-done"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Import complete"].exists)
  }
  func testDuplicateOnlySuccess() {
    let app = open(["--csv-preview", "--csv-duplicates"])
    let confirm = app.buttons["csv-confirm"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 8))
    confirm.tap()
    XCTAssertTrue(app.staticTexts["Already up to date"].waitForExistence(timeout: 8))
  }
  func testUncertainConfirmationRequiresRecovery() {
    let app = open(["--csv-preview", "--csv-error"])
    let confirm = app.buttons["csv-confirm"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 8))
    confirm.tap()
    XCTAssertTrue(app.buttons["Check import result"].waitForExistence(timeout: 8))
    XCTAssertFalse(confirm.isEnabled)
  }
  func testExistingAccountImportAndHistory() {
    let app = XCUIApplication()
    app.launchArguments = ["--ui-fixtures", "--csv-account"]
    app.launch()
    XCTAssertTrue(app.buttons["1M"].waitForExistence(timeout: 15))
    let row = app.buttons.matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "portfolio-account-")
    ).firstMatch
    for _ in 0..<5 {
      if row.isHittable { break }
      app.swipeUp()
    }
    row.tap()
    let history = app.buttons["Import history"]
    for _ in 0..<5 {
      if history.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(history.waitForExistence(timeout: 5))
    history.tap()
    XCTAssertTrue(app.staticTexts["trade-republic.csv"].waitForExistence(timeout: 5))
    app.navigationBars.buttons.element(boundBy: 0).tap()
    let csv = app.buttons["Import CSV"]
    XCTAssertTrue(csv.waitForExistence(timeout: 5))
    csv.tap()
    XCTAssertTrue(app.buttons["csv-choose-file"].waitForExistence(timeout: 5))
  }

}
