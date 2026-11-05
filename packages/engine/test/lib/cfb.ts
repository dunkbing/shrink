// Test writer for compound files: sequential layout with optional free-sector gaps and orphaned data, so there is slack to remove.
export interface CStream {
  path: string;
  data: Uint8Array;
}
export interface CfbSpec {
  version?: 3 | 4;
  streams: CStream[];
  /** Free sectors left after each big stream. */
  gap?: number;
  /** Extra sectors of junk at the end that no chain points to (marked free). */
  trailingFree?: number;
  clsid?: Uint8Array;
}

const FREE = 0xffffffff, END = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc;

export function makeCfb(spec: CfbSpec): Uint8Array {
  const v4 = spec.version === 4;
  const ss = v4 ? 4096 : 512;
  const epc = ss / 4;
  const sectors: Uint8Array[] = [];
  const fat: number[] = [];
  const addChain = (data: Uint8Array): number => {
    const n = Math.max(1, Math.ceil(data.length / ss));
    const start = sectors.length;
    for (let i = 0; i < n; i++) {
      const s = new Uint8Array(ss);
      s.set(data.subarray(i * ss, (i + 1) * ss));
      sectors.push(s);
      fat.push(i === n - 1 ? END : start + i + 1);
    }
    return start;
  };
  const addFree = (n: number) => {
    for (let i = 0; i < n; i++) (sectors.push(new Uint8Array(ss).fill(0xab)), fat.push(FREE));
  };
  // directory model
  type Node = { name: string; type: 1 | 2; children: Map<string, Node>; data?: Uint8Array; start: number };
  const root: Node = { name: "Root Entry", type: 1, children: new Map(), start: END };
  for (const s of spec.streams) {
    const parts = s.path.split("/");
    let n = root;
    parts.forEach((p, i) => {
      if (!n.children.has(p)) n.children.set(p, { name: p, type: i === parts.length - 1 ? 2 : 1, children: new Map(), start: END });
      n = n.children.get(p)!;
    });
    n.data = s.data;
  }
  // mini streams (< 4096), big streams in path order
  const mini: number[] = [];
  const miniChunks: Uint8Array[] = [];
  const all: Node[] = [];
  const collect = (n: Node) => [...n.children.values()].forEach((c) => (all.push(c), collect(c)));
  collect(root);
  for (const n of all) {
    if (n.type !== 2 || !n.data || n.data.length === 0) continue;
    if (n.data.length < 4096) {
      const k = Math.ceil(n.data.length / 64);
      n.start = mini.length;
      for (let i = 0; i < k; i++) mini.push(i === k - 1 ? END : mini.length + 1);
      const c = new Uint8Array(k * 64);
      c.set(n.data);
      miniChunks.push(c);
    } else {
      n.start = addChain(n.data);
      addFree(spec.gap ?? 0);
    }
  }
  const miniStream = Buffer.concat(miniChunks);
  if (miniStream.length) (root.start = addChain(miniStream)), addFree(spec.gap ?? 0);
  let miniFatStart = END, nMini = 0;
  if (mini.length) {
    const b = Buffer.alloc(Math.ceil(mini.length / epc) * ss, 0xff);
    mini.forEach((v, i) => b.writeUInt32LE(v, i * 4));
    nMini = b.length / ss;
    miniFatStart = addChain(b);
  }
  // directory entries in creation order; siblings form a right-linked chain sorted by CFB name order
  const entries: { node: Node; left: number; right: number; child: number }[] = [];
  const emit = (n: Node): number => {
    const idx = entries.length;
    entries.push({ node: n, left: FREE, right: FREE, child: FREE });
    const kids = [...n.children.values()].sort((a, b) => a.name.length - b.name.length || (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : 1));
    const ids = kids.map(emit);
    ids.forEach((id, i) => {
      if (i < ids.length - 1) entries[id].right = ids[i + 1];
    });
    if (ids.length) entries[idx].child = ids[0];
    return idx;
  };
  emit(root);
  const dirBuf = Buffer.alloc(Math.ceil(entries.length / (ss / 128)) * ss);
  for (let i = 0; i < dirBuf.length / 128; i++) {
    const o = i * 128;
    const e = entries[i];
    if (!e) {
      dirBuf.writeUInt32LE(FREE, o + 68), dirBuf.writeUInt32LE(FREE, o + 72), dirBuf.writeUInt32LE(FREE, o + 76);
      continue;
    }
    const nm = Buffer.from(e.node.name + "\0", "utf16le");
    nm.copy(dirBuf, o);
    dirBuf.writeUInt16LE(nm.length, o + 64);
    dirBuf[o + 66] = e === entries[0] ? 5 : e.node.type;
    dirBuf[o + 67] = 1;
    dirBuf.writeUInt32LE(e.left, o + 68), dirBuf.writeUInt32LE(e.right, o + 72), dirBuf.writeUInt32LE(e.child, o + 76);
    if (e === entries[0] && spec.clsid) Buffer.from(spec.clsid).copy(dirBuf, o + 80);
    const isRoot = e === entries[0];
    const size = isRoot ? miniStream.length : (e.node.data?.length ?? 0);
    dirBuf.writeUInt32LE(e.node.type === 1 && !isRoot ? 0 : e.node.start, o + 116);
    dirBuf.writeUInt32LE(e.node.type === 2 && size === 0 ? 0 : size, o + 120);
  }
  const dirStart = addChain(dirBuf);
  addFree(spec.trailingFree ?? 0);
  // FAT sectors
  let f = 1, d = 0;
  for (;;) {
    d = f > 109 ? Math.ceil((f - 109) / (epc - 1)) : 0;
    if (f * epc >= fat.length + f + d) break;
    f++;
  }
  const fatStart = sectors.length;
  for (let i = 0; i < f; i++) (sectors.push(new Uint8Array(ss)), fat.push(FATSECT));
  const difStart = sectors.length;
  for (let i = 0; i < d; i++) (sectors.push(new Uint8Array(ss)), fat.push(DIFSECT));
  while (fat.length < f * epc) fat.push(FREE);
  fat.forEach((v, i) => new DataView(sectors[fatStart + Math.floor(i / epc)].buffer).setUint32((i % epc) * 4, v, true));
  const head = Buffer.alloc(ss);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(head);
  head.writeUInt16LE(0x3e, 0x18), head.writeUInt16LE(v4 ? 4 : 3, 0x1a), head.writeUInt16LE(0xfffe, 0x1c), head.writeUInt16LE(v4 ? 12 : 9, 0x1e), head.writeUInt16LE(6, 0x20);
  head.writeUInt32LE(v4 ? dirBuf.length / ss : 0, 0x28), head.writeUInt32LE(f, 0x2c), head.writeUInt32LE(dirStart, 0x30), head.writeUInt32LE(4096, 0x38);
  head.writeUInt32LE(miniFatStart, 0x3c), head.writeUInt32LE(nMini, 0x40), head.writeUInt32LE(d ? difStart : END, 0x44), head.writeUInt32LE(d, 0x48);
  for (let i = 0; i < 109; i++) head.writeUInt32LE(i < f ? fatStart + i : FREE, 0x4c + i * 4);
  for (let j = 0; j < d; j++) {
    const dv = new DataView(sectors[difStart + j].buffer);
    for (let k = 0; k < epc - 1; k++) dv.setUint32(k * 4, 109 + j * (epc - 1) + k < f ? fatStart + 109 + j * (epc - 1) + k : FREE, true);
    dv.setUint32(ss - 4, j === d - 1 ? END : difStart + j + 1, true);
  }
  return Buffer.concat([head, ...sectors]);
}
