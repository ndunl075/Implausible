/**
 * Builds a minimal, valid MaxMind DB (.mmdb) in memory.
 *
 * The geo lookup was the one part of ingest with no real coverage: the tests
 * only ever exercised the path where no database is configured. Proving it
 * actually resolves a country needs an actual .mmdb, and the real GeoLite2
 * file cannot be committed — it needs a MaxMind account and carries its own
 * licence.
 *
 * So this writes one. It is a test fixture, not a general-purpose writer: IPv4
 * only, 32-bit records, and just enough of the data-section encoding to hold
 * `{"country": {"iso_code": "XX"}}`. That is the whole shape Implausible reads,
 * because a country code is the only thing it is willing to look up.
 *
 * Format reference: https://maxmind.github.io/MaxMind-DB/
 * Layout: [search tree][16 zero bytes][data section][marker][metadata]
 */

const MARKER = Buffer.from('\xAB\xCD\xEFMaxMind.com', 'binary');

/** Data-section type numbers from the spec. */
const TYPE = {
  utf8: 2,
  uint16: 5,
  uint32: 6,
  map: 7,
  uint64: 9,
  array: 11,
};

/**
 * Control byte, plus the extended type byte and extended size bytes.
 *
 * Types above 7 do not fit in the control byte's three type bits, so the type
 * bits are zeroed and the real type follows in the next byte. The extended
 * size bytes come after that, not before it.
 */
function control(type, size) {
  const bytes = [];
  let sizeBits;
  const sizeExtra = [];

  if (size < 29) {
    sizeBits = size;
  } else if (size < 285) {
    sizeBits = 29;
    sizeExtra.push(size - 29);
  } else if (size < 65821) {
    sizeBits = 30;
    const value = size - 285;
    sizeExtra.push((value >> 8) & 0xff, value & 0xff);
  } else {
    sizeBits = 31;
    const value = size - 65821;
    sizeExtra.push((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
  }

  if (type <= 7) {
    bytes.push((type << 5) | sizeBits);
  } else {
    bytes.push(sizeBits); // type bits zero => extended
    bytes.push(type - 7);
  }
  bytes.push(...sizeExtra);
  return Buffer.from(bytes);
}

/** Unsigned integers are stored big-endian with leading zero bytes stripped. */
function uintBytes(value) {
  const bytes = [];
  let remaining = BigInt(value);
  while (remaining > 0n) {
    bytes.unshift(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  return Buffer.from(bytes);
}

function encodeUint(type, value) {
  const payload = uintBytes(value);
  return Buffer.concat([control(type, payload.length), payload]);
}

function encodeString(value) {
  const payload = Buffer.from(value, 'utf8');
  return Buffer.concat([control(TYPE.utf8, payload.length), payload]);
}

function encodeMap(entries) {
  const parts = [control(TYPE.map, entries.length)];
  for (const [key, value] of entries) {
    parts.push(encodeString(key), value);
  }
  return Buffer.concat(parts);
}

function encodeArray(items) {
  return Buffer.concat([control(TYPE.array, items.length), ...items]);
}

/** `{"country": {"iso_code": "GB"}}` — the only record shape we produce. */
function encodeCountry(isoCode) {
  return encodeMap([['country', encodeMap([['iso_code', encodeString(isoCode)]])]]);
}

/**
 * Builds the binary search tree.
 *
 * Each node holds two records. A record below `nodeCount` is the index of
 * another node, a record equal to `nodeCount` means "no data here", and
 * anything above it is a data-section offset biased by `nodeCount + 16` — the
 * 16 accounting for the separator between the tree and the data section.
 */
function buildTree(networks) {
  const nodes = [[null, null]];

  for (const { cidr, country } of networks) {
    const [address, length] = cidr.split('/');
    const prefixLength = Number(length);
    const octets = address.split('.').map(Number);

    let current = 0;
    for (let depth = 0; depth < prefixLength; depth++) {
      const bit = (octets[depth >> 3] >> (7 - (depth % 8))) & 1;

      if (depth === prefixLength - 1) {
        nodes[current][bit] = { country };
        break;
      }

      const existing = nodes[current][bit];
      if (existing && existing.node !== undefined) {
        current = existing.node;
      } else {
        nodes.push([null, null]);
        const index = nodes.length - 1;
        nodes[current][bit] = { node: index };
        current = index;
      }
    }
  }

  return nodes;
}

/**
 * Assembles a complete .mmdb.
 *
 * @param {Array<{cidr: string, country: string}>} networks IPv4 networks to map.
 * @returns {Buffer} the database, ready to write to disk.
 */
export function buildCountryMmdb(networks) {
  const nodes = buildTree(networks);
  const nodeCount = nodes.length;
  const recordSize = 32;

  // Data section: one entry per distinct country, offsets recorded as we go.
  const offsets = new Map();
  const dataParts = [];
  let dataLength = 0;

  for (const { country } of networks) {
    if (offsets.has(country)) continue;
    const encoded = encodeCountry(country);
    offsets.set(country, dataLength);
    dataParts.push(encoded);
    dataLength += encoded.length;
  }

  const resolve = (record) => {
    if (record === null) return nodeCount; // no data
    if (record.node !== undefined) return record.node;
    return nodeCount + 16 + offsets.get(record.country);
  };

  const tree = Buffer.alloc(nodeCount * ((recordSize * 2) / 8));
  nodes.forEach(([left, right], index) => {
    tree.writeUInt32BE(resolve(left), index * 8);
    tree.writeUInt32BE(resolve(right), index * 8 + 4);
  });

  const metadata = encodeMap([
    ['binary_format_major_version', encodeUint(TYPE.uint16, 2)],
    ['binary_format_minor_version', encodeUint(TYPE.uint16, 0)],
    ['build_epoch', encodeUint(TYPE.uint64, Math.floor(Date.now() / 1000))],
    ['database_type', encodeString('GeoLite2-Country')],
    ['description', encodeMap([['en', encodeString('Implausible test fixture')]])],
    ['ip_version', encodeUint(TYPE.uint16, 4)],
    ['languages', encodeArray([encodeString('en')])],
    ['node_count', encodeUint(TYPE.uint32, nodeCount)],
    ['record_size', encodeUint(TYPE.uint16, recordSize)],
  ]);

  return Buffer.concat([
    tree,
    Buffer.alloc(16), // separator
    ...dataParts,
    MARKER,
    metadata,
  ]);
}
