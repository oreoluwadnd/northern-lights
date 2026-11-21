// Draws the Northern Lights app icon (1024×1024 PNG). Usage: icon <out.png>
import AppKit
import CoreGraphics

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let cs = CGColorSpaceCreateDeviceRGB()
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: r / 255, green: g / 255, blue: b / 255, alpha: a)
}

// macOS icon grid: 824pt body centred in 1024 with a continuous-ish corner.
let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)

// Soft drop shadow.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 30, color: rgb(0, 0, 0, 0.35))
ctx.addPath(shape)
ctx.setFillColor(rgb(10, 14, 30))
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(shape)
ctx.clip()

// Night sky.
let sky = CGGradient(colorsSpace: cs, colors: [rgb(28, 34, 70), rgb(12, 16, 34), rgb(6, 8, 18)] as CFArray, locations: [0, 0.55, 1])!
ctx.drawLinearGradient(sky, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])

// Stars.
var seed: UInt64 = 7
func rnd() -> CGFloat { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return CGFloat(seed >> 33) / CGFloat(UInt32.max) }
for _ in 0..<70 {
    let x = 110 + rnd() * 804, y = 420 + rnd() * 500, r = 1.2 + rnd() * 3.2
    ctx.setFillColor(rgb(255, 255, 255, 0.25 + rnd() * 0.6))
    ctx.fillEllipse(in: CGRect(x: x, y: y, width: r, height: r))
}

// Aurora curtains: soft, wide gradient strokes along flowing curves.
func ribbon(_ pts: [CGPoint], width: CGFloat, colors: [CGColor], alpha: CGFloat, blur: CGFloat) {
    let path = CGMutablePath()
    path.move(to: pts[0])
    var i = 1
    while i + 2 < pts.count + 1 && i + 1 < pts.count {
        path.addQuadCurve(to: pts[i + 1], control: pts[i])
        i += 2
    }
    ctx.saveGState()
    ctx.setAlpha(alpha)
    ctx.setShadow(offset: .zero, blur: blur, color: colors[1])
    ctx.addPath(path)
    ctx.setLineWidth(width)
    ctx.setLineCap(.round)
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    let g = CGGradient(colorsSpace: cs, colors: colors as CFArray, locations: [0, 0.5, 1])!
    ctx.drawLinearGradient(g, start: CGPoint(x: 100, y: 300), end: CGPoint(x: 924, y: 820), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    ctx.restoreGState()
}

let green = rgb(52, 230, 160), cyan = rgb(34, 211, 238), violet = rgb(160, 120, 250)
ribbon([CGPoint(x: 40, y: 380), CGPoint(x: 300, y: 760), CGPoint(x: 520, y: 600), CGPoint(x: 760, y: 430), CGPoint(x: 1000, y: 800)],
       width: 150, colors: [green, cyan, violet], alpha: 0.55, blur: 60)
ribbon([CGPoint(x: 60, y: 300), CGPoint(x: 330, y: 640), CGPoint(x: 540, y: 520), CGPoint(x: 760, y: 380), CGPoint(x: 990, y: 690)],
       width: 70, colors: [green, cyan, violet], alpha: 0.9, blur: 40)
ribbon([CGPoint(x: 80, y: 470), CGPoint(x: 360, y: 840), CGPoint(x: 560, y: 700), CGPoint(x: 780, y: 560), CGPoint(x: 980, y: 880)],
       width: 34, colors: [cyan, violet, green], alpha: 0.75, blur: 30)

// Horizon glow and hills.
let glow = CGGradient(colorsSpace: cs, colors: [rgb(45, 212, 191, 0.35), rgb(45, 212, 191, 0)] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 230), startRadius: 0, endCenter: CGPoint(x: 512, y: 230), endRadius: 420, options: [])
let hills = CGMutablePath()
hills.move(to: CGPoint(x: 100, y: 250))
hills.addQuadCurve(to: CGPoint(x: 420, y: 230), control: CGPoint(x: 260, y: 330))
hills.addQuadCurve(to: CGPoint(x: 924, y: 270), control: CGPoint(x: 680, y: 120))
hills.addLine(to: CGPoint(x: 924, y: 100))
hills.addLine(to: CGPoint(x: 100, y: 100))
hills.closeSubpath()
ctx.addPath(hills)
ctx.setFillColor(rgb(5, 7, 14))
ctx.fillPath()
ctx.restoreGState()

// Thin inner border for definition on dark docks.
ctx.addPath(CGPath(roundedRect: body.insetBy(dx: 1.5, dy: 1.5), cornerWidth: 184, cornerHeight: 184, transform: nil))
ctx.setStrokeColor(rgb(255, 255, 255, 0.10))
ctx.setLineWidth(3)
ctx.strokePath()

let img = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
