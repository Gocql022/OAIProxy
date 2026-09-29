import * as zlib from "zlib";

export function png(width = 744, height = 1053, padding = 0): Uint8Array {
	const crc = (bytes: Buffer): number => {
		let crc = 0xffffffff;
		for (const byte of bytes) {
			crc ^= byte;
			for (let i = 0; i < 8; i++) {
				crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
			}
		}
		return (crc ^ 0xffffffff) >>> 0;
	};
	const chunk = (name: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(name), data]);
		const size = Buffer.alloc(4);
		size.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc(body));
		return Buffer.concat([size, body, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
	for (let y = 0; y < height; y++) {
		pixels[y * (width * 3 + 1)] = 0;
	}
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			chunk("IHDR", header),
			chunk("tEXt", Buffer.concat([Buffer.from("Comment\0"), Buffer.alloc(padding, 65)])),
			chunk("IDAT", zlib.deflateSync(pixels)),
			chunk("IEND", Buffer.alloc(0)),
		])
	);
}
