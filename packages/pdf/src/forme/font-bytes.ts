import { unzlibSync } from "fflate";

const WOFF = 0x774f4646; // "wOFF"

/** WOFF 1.0 → sfnt: inflate each table and lay them out after a fresh table directory. */
function woffToSfnt(bytes: Uint8Array): Uint8Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const flavor = view.getUint32(4);
	const numTables = view.getUint16(12);

	const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
	for (let index = 0; index < numTables; index++) {
		const entry = 44 + index * 20;
		const tag = view.getUint32(entry);
		const offset = view.getUint32(entry + 4);
		const compLength = view.getUint32(entry + 8);
		const origLength = view.getUint32(entry + 12);
		const checksum = view.getUint32(entry + 16);
		const stored = bytes.subarray(offset, offset + compLength);
		const data = compLength < origLength ? unzlibSync(stored) : stored;
		tables.push({ tag, checksum, data });
	}

	const headerLength = 12 + numTables * 16;
	const padded = (length: number) => (length + 3) & ~3;
	const total = tables.reduce((sum, table) => sum + padded(table.data.length), headerLength);
	const out = new Uint8Array(total);
	const outView = new DataView(out.buffer);

	let searchRange = 1;
	let entrySelector = 0;
	while (searchRange * 2 <= numTables) {
		searchRange *= 2;
		entrySelector++;
	}
	outView.setUint32(0, flavor);
	outView.setUint16(4, numTables);
	outView.setUint16(6, searchRange * 16);
	outView.setUint16(8, entrySelector);
	outView.setUint16(10, numTables * 16 - searchRange * 16);

	let dataOffset = headerLength;
	tables.forEach((table, index) => {
		const record = 12 + index * 16;
		outView.setUint32(record, table.tag);
		outView.setUint32(record + 4, table.checksum);
		outView.setUint32(record + 8, dataOffset);
		outView.setUint32(record + 12, table.data.length);
		out.set(table.data, dataOffset);
		dataOffset += padded(table.data.length);
	});
	return out;
}

/** WOFF 1.0 becomes sfnt; other supported formats pass through unchanged. */
export function prepareFontBytes(bytes: Uint8Array): Uint8Array {
	if (bytes.byteLength < 12) return bytes;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return view.getUint32(0) === WOFF ? woffToSfnt(bytes) : bytes;
}

/** The Arabic bit in the OpenType OS/2 table's first Unicode range field. */
export function declaresArabicCoverage(bytes: Uint8Array): boolean | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.byteLength < 12) return undefined;
	const tableCount = view.getUint16(4);
	for (let index = 0; index < tableCount; index++) {
		const record = 12 + index * 16;
		if (record + 16 > view.byteLength) return undefined;
		if (view.getUint32(record) !== 0x4f532f32) continue; // OS/2
		const start = view.getUint32(record + 8);
		if (view.getUint32(record + 12) < 46 || start + 46 > view.byteLength) return undefined;
		return (view.getUint32(start + 42) & (1 << 13)) !== 0;
	}
	return undefined;
}
