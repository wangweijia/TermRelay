import SwiftUI
import UniformTypeIdentifiers

struct ChatAttachmentCard: View {
    let attachment: ChatAttachment
    let sessionID: UUID
    var remove: (() -> Void)? = nil
    @State private var thumbnail: NSImage?
    @State private var unavailable = false

    var body: some View {
        HStack(spacing: 8) {
            if let thumbnail {
                Image(nsImage: thumbnail).resizable().scaledToFit().frame(width: 64, height: 48)
            } else {
                Image(systemName: attachment.mimeType.hasPrefix("image/") ? "photo" : "doc")
            }
            VStack(alignment: .leading) {
                Text(attachment.name).lineLimit(1)
                Text(unavailable ? "附件不可用或已清理" : ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let remove { Button(action: remove) { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).help("移除附件") }
        }
        .padding(8).background(.quaternary).clipShape(RoundedRectangle(cornerRadius: 6))
        .task(id: attachment.id) {
            guard let id = UUID(uuidString: attachment.id) else { return }
            let result = await AttachmentStore.shared.thumbnail(sessionID: sessionID, id: id)
            unavailable = !result.available
            if let data = result.data { thumbnail = NSImage(data: data) }
        }
    }
}

/// Keep normal text editing while accepting files and image clipboard content.
struct AttachmentTextEditor: NSViewRepresentable {
    @Binding var text: String
    var disabled: Bool
    var onFiles: ([URL]) -> Void
    var onImage: (Data) -> Void
    var onKey: (NSEvent) -> Bool

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        let view = AttachmentPasteTextView(frame: NSRect(x: 0, y: 0, width: 320, height: 56))
        view.isRichText = false
        view.allowsUndo = true
        view.font = .systemFont(ofSize: NSFont.systemFontSize)
        view.textContainerInset = NSSize(width: 5, height: 5)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.minSize = NSSize(width: 0, height: 56)
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.delegate = context.coordinator
        view.registerForDraggedTypes([.fileURL])
        scroll.documentView = view
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.horizontalScrollElasticity = .none
        updateNSView(scroll, context: context)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? AttachmentPasteTextView else { return }
        context.coordinator.parent = self
        if !view.hasMarkedText(), view.string != text { view.string = text }
        if view.isEditable != !disabled { view.isEditable = !disabled }
        view.onFiles = onFiles
        view.onImage = onImage
        view.onKey = onKey
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: AttachmentTextEditor
        init(_ parent: AttachmentTextEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            if let view = notification.object as? NSTextView { parent.text = view.string }
        }
    }
}

@MainActor private final class AttachmentPasteTextView: NSTextView {
    var onFiles: (([URL]) -> Void)?
    var onImage: ((Data) -> Void)?
    var onKey: ((NSEvent) -> Bool)?
    override func keyDown(with event: NSEvent) {
        if isEditable, !hasMarkedText(), onKey?(event) == true { return }
        super.keyDown(with: event)
    }
    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        if isEditable, sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) { return .copy }
        return super.draggingEntered(sender)
    }
    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        guard isEditable else { return false }
        if let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            onFiles?(urls); return true
        }
        return super.performDragOperation(sender)
    }
    override func paste(_ sender: Any?) {
        guard isEditable else { return }
        let pasteboard = NSPasteboard.general
        let urls = (pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        if !urls.isEmpty { onFiles?(urls); return }
        if let data = pasteboard.data(forType: .png) { onImage?(data); return }
        if let data = pasteboard.data(forType: .tiff), let image = NSBitmapImageRep(data: data),
           let png = image.representation(using: .png, properties: [:]) { onImage?(png); return }
        super.paste(sender)
    }
}
