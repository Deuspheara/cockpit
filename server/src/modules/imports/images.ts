import { AppError } from "../../shared/errors.js";
export function validateImage(bytes: Buffer, mime: string, maxBytes: number) {
  if (bytes.length === 0 || bytes.length > maxBytes)
    throw new AppError("UPLOAD_LIMIT", "Image exceeds the allowed size", 413);
  const png =
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg =
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255;
  if (!((mime === "image/png" && png) || (mime === "image/jpeg" && jpeg)))
    throw new AppError(
      "INVALID_IMAGE",
      "Upload a PNG or JPEG with matching image bytes",
    );
  if (png && (bytes.readUInt32BE(16) > 20000 || bytes.readUInt32BE(20) > 20000))
    throw new AppError("INVALID_IMAGE", "Image dimensions exceed the limit");
}

/** Take ownership of multipart chunks, clearing every chunk even on a limit or stream error. */
export async function readImageBytes(
  stream: AsyncIterable<Buffer>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      length += chunk.length;
      if (length > maxBytes)
        throw new AppError(
          "UPLOAD_LIMIT",
          "Image exceeds the allowed size",
          413,
        );
    }
    return Buffer.concat(chunks, length);
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
  }
}
