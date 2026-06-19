import { execCommand } from "./shell.js";

const PDF_TEXT_SCRIPT = `
import Foundation
import PDFKit
let file = CommandLine.arguments[1]
if let doc = PDFDocument(url: URL(fileURLWithPath: file)) {
  var parts: [String] = []
  for i in 0..<doc.pageCount {
    if let page = doc.page(at: i), let text = page.string, !text.isEmpty {
      parts.append(text)
    }
  }
  print(parts.joined(separator: "\\n\\n"))
}
`;

const VIDEO_FRAMES_SCRIPT = `
import Foundation
import AVFoundation
import AppKit

let input = URL(fileURLWithPath: CommandLine.arguments[1])
let outputDir = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let asset = AVAsset(url: input)
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.maximumSize = CGSize(width: 1280, height: 1280)

let durationSeconds = CMTimeGetSeconds(asset.duration)
let points: [Double]
if durationSeconds.isFinite && durationSeconds > 0 {
  if durationSeconds < 3 {
    points = [durationSeconds / 2]
  } else {
    points = [durationSeconds * 0.2, durationSeconds * 0.5, durationSeconds * 0.8]
  }
} else {
  points = [0.0]
}

FileManager.default.createFile(atPath: outputDir.path, contents: nil)
try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

var saved: [String] = []
for (idx, sec) in points.enumerated() {
  let time = CMTime(seconds: sec, preferredTimescale: 600)
  if let imageRef = try? generator.copyCGImage(at: time, actualTime: nil) {
    let image = NSImage(cgImage: imageRef, size: .zero)
    if let tiff = image.tiffRepresentation,
       let rep = NSBitmapImageRep(data: tiff),
       let png = rep.representation(using: .png, properties: [:]) {
      let out = outputDir.appendingPathComponent("frame-\\(idx + 1).png")
      try? png.write(to: out)
      saved.append(out.path)
    }
  }
}
print(saved.joined(separator: "\\n"))
`;

export async function extractPdfText(filePath) {
  try {
    const output = await execCommand("/usr/bin/swift", ["-e", PDF_TEXT_SCRIPT, filePath]);
    return output.trim() || null;
  } catch {
    return null;
  }
}

export async function extractVideoFrames(filePath, outputDir) {
  try {
    const output = await execCommand("/usr/bin/swift", ["-e", VIDEO_FRAMES_SCRIPT, filePath, outputDir]);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
