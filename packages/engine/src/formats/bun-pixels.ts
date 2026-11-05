// "Same picture" for 8-bit formats Bun decodes natively (JPEG, WebP): both decode to the same canonical PNG.
export interface Pixels {
  width: number;
  height: number;
  hash: bigint | number;
}

export async function pixels(bytes: Uint8Array): Promise<Pixels> {
  const img = new Bun.Image(bytes);
  const { width, height } = await img.metadata();
  const png = await new Bun.Image(bytes).png({ compressionLevel: 1 }).bytes();
  return { width, height, hash: Bun.hash(png) };
}

export function samePicture(a: Pixels, b: Pixels): true | string {
  if (a.width !== b.width || a.height !== b.height) return `size ${a.width}x${a.height} became ${b.width}x${b.height}`;
  return a.hash === b.hash ? true : "pixels differ";
}
