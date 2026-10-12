// make-icon.swift — shapes the source into the macOS app-icon form:
// 824×824 squircle centered on a transparent 1024×1024 canvas (Apple's
// macOS icon template). The same RGBA output feeds `tauri icon`, so
// Windows (.ico) and Linux (.png) get the identical shape.
//
// macOS does NOT mask or background app icons automatically (that's iOS) —
// the tile must be baked into the file, which is what this script does.
//
// Usage: swift make-icon.swift <source.png> <output.png> [tile]
//   (no mode)  — source aspect-fills the whole tile (full-bleed art)
//   tile       — dark CRS-Theme gradient tile + source as the glyph (80%)

import AppKit

let args = CommandLine.arguments
guard (3...4).contains(args.count) else {
    fputs("usage: swift make-icon.swift <source.png> <output.png> [tile]\n", stderr)
    exit(1)
}

guard let raw = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
      let source = NSImage(data: raw)
else {
    fputs("cannot read source image: \(args[1])\n", stderr)
    exit(1)
}

let canvas: CGFloat = 1024
let tile: CGFloat = 824 // Apple macOS icon tile
let radius: CGFloat = 185 // Apple's squircle corner radius for the 824 tile

let image = NSImage(size: NSSize(width: canvas, height: canvas))
image.lockFocus()

NSColor.clear.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: canvas, height: canvas)).fill()

let inset = (canvas - tile) / 2
let tileRect = NSRect(x: inset, y: inset, width: tile, height: tile)
let squircle = NSBezierPath(roundedRect: tileRect, xRadius: radius, yRadius: radius)

let tileMode = args.count > 3 && args[3] == "tile"

if tileMode {
    // Dark CRS-Theme gradient tile (card → background), like a dark-mode app icon.
    squircle.addClip()
    let top = NSColor(srgbRed: 0x1a / 255.0, green: 0x1a / 255.0, blue: 0x1a / 255.0, alpha: 1)
    let bottom = NSColor(srgbRed: 0x0a / 255.0, green: 0x0a / 255.0, blue: 0x0a / 255.0, alpha: 1)
    NSGradient(starting: top, ending: bottom)?
        .draw(in: squircle, angle: -90)
} else {
    squircle.addClip()
}

// Aspect-fit the source inside the tile (never stretch), centered.
// In tile mode the source is the glyph — drawn at 80% of the tile.
let contentSize = tileMode ? tile * 0.8 : tile
let srcSize = source.size
let scale = min(contentSize / srcSize.width, contentSize / srcSize.height)
let drawWidth = srcSize.width * scale
let drawHeight = srcSize.height * scale
let drawRect = NSRect(
    x: inset + (tile - drawWidth) / 2,
    y: inset + (tile - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight
)
source.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:])
else {
    fputs("PNG encoding failed\n", stderr)
    exit(1)
}
do {
    try png.write(to: URL(fileURLWithPath: args[2]), options: .atomic)
    print("written \(args[2])")
} catch {
    fputs("write failed: \(error)\n", stderr)
    exit(1)
}
