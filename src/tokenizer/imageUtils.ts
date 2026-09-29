export interface ImageSize {
	width: number;
	height: number;
}

/** Header-only reads, with bounds checks and typed-array slice support. */
export function readImageSize(bytes: Uint8Array, mime: string): ImageSize | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
	let size: ImageSize | undefined;
	mime = mime.toLowerCase().split(";")[0].trim();
	if (
		mime === "image/png" &&
		bytes.length >= 24 &&
		view.getUint32(0) === 0x89504e47 &&
		view.getUint32(4) === 0x0d0a1a0a &&
		view.getUint32(8) === 13 &&
		ascii(12, 4) === "IHDR"
	) {
		size = { width: view.getUint32(16), height: view.getUint32(20) };
	} else if (mime === "image/gif" && bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) {
		size = { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	} else if ((mime === "image/jpeg" || mime === "image/jpg") && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 1 < bytes.length) {
			if (bytes[offset++] !== 0xff) {
				break;
			}
			while (bytes[offset] === 0xff) {
				offset++;
			}
			const marker = bytes[offset++];
			if (marker === 0xda || marker === 0xd9 || marker === undefined) {
				break;
			}
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				continue;
			}
			if (offset + 2 > bytes.length) {
				break;
			}
			const length = view.getUint16(offset);
			if (length < 2 || offset + length > bytes.length) {
				break;
			}
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
				size = { height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
				break;
			}
			offset += length;
		}
	} else if (mime === "image/webp" && bytes.length >= 20 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
		const end = Math.min(bytes.length, view.getUint32(4, true) + 8);
		for (let offset = 12; offset + 8 <= end; ) {
			const kind = ascii(offset, 4);
			const length = view.getUint32(offset + 4, true);
			const data = offset + 8;
			if (data + length > end) {
				break;
			}
			if (kind === "VP8X" && length >= 10) {
				const uint24 = (at: number) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
				size = { width: uint24(data + 4) + 1, height: uint24(data + 7) + 1 };
			} else if (kind === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
				const bits = view.getUint32(data + 1, true);
				size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
			} else if (kind === "VP8 " && length >= 10 && ascii(data + 3, 3) === "\x9d\x01\x2a") {
				size = { width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff };
			}
			if (size) {
				break;
			}
			offset = data + length + (length % 2);
		}
	}
	return size && size.width > 0 && size.height > 0 ? size : undefined;
}
