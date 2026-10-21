export function pngSize(head: Buffer): [number, number] {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (head.length < 24 || !head.subarray(0, 8).equals(sig)) throw new Error("Not a PNG file");
  return [head.readUInt32BE(16), head.readUInt32BE(20)];
}
