// make-icon.swift — shapes the source into the macOS app-icon form:
// 824×824 squircle centered on a transparent 1024×1024 canvas (Apple's
// macOS icon template). The same RGBA output feeds `tauri icon`, so
// Windows (.ico) and Linux (.png) get the identical shape.
//
// macOS does NOT mask or background app icons automatically (that's iOS) —
// the tile must be baked into the file, which is what this script does.
//
// Usage: swift make-icon.swift <source.png> <output.png> [mode]
//   (no mode)  — source aspect-fills the whole tile (full-bleed art)
//   tile       — dark CRS-Theme gradient tile + source as the glyph (80%)
//   glass      — Liquid Glass tile: baked drop shadow, glossy rim light,
//                top sheen + bottom reflection, inner bottom shadow, and
//                the glyph floating on its own soft shadow — matching the
//                modern macOS dock look.

import AppKit

let args = CommandLine.arguments
guard (3...4).contains(args.count) else {
    fputs("usage: swift make-icon.swift <source.png> <output.png> [tile|glass]\n", stderr)
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
let radius: CGFloat = 185.4 // Apple's squircle corner radius for the 824 tile

let image = NSImage(size: NSSize(width: canvas, height: canvas))
image.lockFocus()

NSColor.clear.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: canvas, height: canvas)).fill()

let inset = (canvas - tile) / 2
let tileRect = NSRect(x: inset, y: inset, width: tile, height: tile)
let squircle = NSBezierPath(roundedRect: tileRect, xRadius: radius, yRadius: radius)

let mode = args.count > 3 ? args[3] : ""
let glassMode = mode == "glass"
let tileMode = mode == "tile" || glassMode

// The baked drop shadow comes first, so every tile layer sits on top of it.
if glassMode {
    NSGraphicsContext.current?.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
    shadow.shadowBlurRadius = 36
    shadow.shadowOffset = NSSize(width: 0, height: -14)
    shadow.set()
    squircle.addClip()
    let top = NSColor(srgbRed: 0x1a / 255.0, green: 0x1a / 255.0, blue: 0x1a / 255.0, alpha: 1)
    let bottom = NSColor(srgbRed: 0x0a / 255.0, green: 0x0a / 255.0, blue: 0x0a / 255.0, alpha: 1)
    NSGradient(starting: top, ending: bottom)?
        .draw(in: squircle, angle: -90)
    NSGraphicsContext.current?.restoreGraphicsState()
} else if mode == "tile" {
    squircle.addClip()
    let top = NSColor(srgbRed: 0x1a / 255.0, green: 0x1a / 255.0, blue: 0x1a / 255.0, alpha: 1)
    let bottom = NSColor(srgbRed: 0x0a / 255.0, green: 0x0a / 255.0, blue: 0x0a / 255.0, alpha: 1)
    NSGradient(starting: top, ending: bottom)?
        .draw(in: squircle, angle: -90)
} else {
    squircle.addClip()
}

if glassMode {
    // Interior layers live inside the clip; the rim strokes on top of it.
    NSGraphicsContext.current?.saveGraphicsState()
    squircle.addClip()

    // Top sheen: the signature glass gloss, strongest at the very top and
    // gone by mid-tile.
    let sheenRect = NSRect(x: tileRect.minX, y: tileRect.midY, width: tileRect.width, height: tileRect.height / 2)
    let sheen = NSGradient(colors: [
        NSColor.white.withAlphaComponent(0.16),
        NSColor.white.withAlphaComponent(0.05),
        NSColor.white.withAlphaComponent(0.0),
    ])
    sheen?.draw(in: NSBezierPath(rect: sheenRect), angle: -90)

    // Bottom reflection: a faint light returning from the "surface" below.
    let reflectRect = NSRect(x: tileRect.minX, y: tileRect.minY, width: tileRect.width, height: tileRect.height * 0.2)
    let reflect = NSGradient(colors: [
        NSColor.white.withAlphaComponent(0.06),
        NSColor.white.withAlphaComponent(0.0),
    ])
    reflect?.draw(in: NSBezierPath(rect: reflectRect), angle: 90)

    // Inner bottom shadow: grounds the tile the way real glass would.
    let innerShadowRect = NSRect(x: tileRect.minX, y: tileRect.minY, width: tileRect.width, height: tileRect.height * 0.12)
    let innerShadow = NSGradient(colors: [
        NSColor.black.withAlphaComponent(0.30),
        NSColor.black.withAlphaComponent(0.0),
    ])
    innerShadow?.draw(in: NSBezierPath(rect: innerShadowRect), angle: 90)

    NSGraphicsContext.current?.restoreGraphicsState()

    // Rim light: a hairline of light along the edge plus a darker seat
    // right outside it — the border that reads as "glass" at dock size.
    let rim = NSBezierPath(roundedRect: tileRect.insetBy(dx: 1.5, dy: 1.5), xRadius: radius - 1.5, yRadius: radius - 1.5)
    rim.lineWidth = 3
    NSColor.white.withAlphaComponent(0.22).setStroke()
    rim.stroke()

    let seat = NSBezierPath(roundedRect: tileRect.insetBy(dx: -1.5, dy: -1.5), xRadius: radius + 1.5, yRadius: radius + 1.5)
    seat.lineWidth = 2
    NSColor.black.withAlphaComponent(0.28).setStroke()
    seat.stroke()
}

// Aspect-fit the source inside the tile (never stretch), centered.
// In tile mode the source is the glyph — 80% on the plain tile, floating
// at 62% with its own shadow on glass.
let glyphShare: CGFloat = glassMode ? 0.62 : (tileMode ? 0.8 : 1.0)
let contentSize = tile * glyphShare
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

if glassMode {
    // The glyph floats above the glass on a soft contact shadow.
    NSGraphicsContext.current?.saveGraphicsState()
    let glyphShadow = NSShadow()
    glyphShadow.shadowColor = NSColor.black.withAlphaComponent(0.4)
    glyphShadow.shadowBlurRadius = 20
    glyphShadow.shadowOffset = NSSize(width: 0, height: -8)
    glyphShadow.set()
    source.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)
    NSGraphicsContext.current?.restoreGraphicsState()
} else {
    source.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)
}

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
