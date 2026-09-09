import Foundation

@MainActor
protocol TerminalRenderer: AnyObject {
    func feed(_ bytes: Data)
    func resize(columns: Int, rows: Int)
}

