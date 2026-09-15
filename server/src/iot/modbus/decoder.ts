import type { ModbusDatatype } from '../../db/repositories/meters.js';

/**
 * Modbus value decoding (spec section 5).
 *
 * Registers are 16-bit words. A 32- or 64-bit quantity spans several of them,
 * and meter vendors disagree about the order the words and their bytes come in.
 * Two independent switches cover every layout in the wild:
 *
 *   byteOrder  order of the two bytes inside one register
 *   wordOrder  order of the registers inside one multi-register value
 *
 *   big/big       ABCD   (the Modbus default)
 *   big/little    CDAB   ("word swapped" - very common on energy meters)
 *   little/big    BADC   ("byte swapped")
 *   little/little DCBA   (fully reversed)
 *
 * None of these are guessed at runtime: they come from the register map row,
 * which is filled in from the meter's own manual.
 */

export type ByteOrder = 'big' | 'little';
export type WordOrder = 'big' | 'little';

export interface DecodeSpec {
  datatype: ModbusDatatype;
  byteOrder?: ByteOrder;
  wordOrder?: WordOrder;
  /** Number of 16-bit registers the value occupies. */
  registerLength?: number;
  scale?: number;
  offset?: number;
  bitMask?: number | null;
  bitOffset?: number | null;
}

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

/** How many 16-bit registers a datatype occupies by default. */
export function defaultRegisterLength(datatype: ModbusDatatype): number {
  switch (datatype) {
    case 'INT16':
    case 'UINT16':
    case 'BOOL':
    case 'BITFIELD':
      return 1;
    case 'INT32':
    case 'UINT32':
    case 'FLOAT32':
      return 2;
    case 'INT64':
    case 'UINT64':
    case 'FLOAT64':
      return 4;
    case 'STRING':
      return 1;
  }
}

/** Parse a hex string (with or without separators) into 16-bit words. */
export function hexToWords(hex: string): number[] {
  const clean = hex.replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
  if (clean.length % 4 !== 0) {
    throw new DecodeError('Hex register data must be a whole number of 16-bit words, got ' + clean.length + ' nibbles.');
  }
  const words: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    words.push(Number.parseInt(clean.slice(index, index + 4), 16));
  }
  return words;
}

/**
 * Lay registers out as a byte buffer in canonical big-endian order, applying
 * the configured byte and word swaps first.
 */
export function wordsToBuffer(words: number[], byteOrder: ByteOrder, wordOrder: WordOrder): Buffer {
  const ordered = wordOrder === 'little' ? [...words].reverse() : words;
  const buffer = Buffer.alloc(ordered.length * 2);
  ordered.forEach((word, index) => {
    const value = word & 0xffff;
    const high = (value >> 8) & 0xff;
    const low = value & 0xff;
    if (byteOrder === 'little') {
      buffer[index * 2] = low;
      buffer[index * 2 + 1] = high;
    } else {
      buffer[index * 2] = high;
      buffer[index * 2 + 1] = low;
    }
  });
  return buffer;
}

export interface DecodedValue {
  /** Engineering value: raw * scale + offset. */
  value: number;
  /** Value before scaling, useful for diagnostics. */
  raw: number;
}

/**
 * Decode one value out of `words`.
 *
 * @throws DecodeError when the register block is too short for the datatype -
 *         which is a configuration error worth surfacing, not silently zeroing.
 */
export function decodeRegisters(words: number[], spec: DecodeSpec): DecodedValue {
  const datatype = spec.datatype;
  const needed = spec.registerLength ?? defaultRegisterLength(datatype);
  if (words.length < needed) {
    throw new DecodeError(
      'Need ' + needed + ' register(s) to decode ' + datatype + ', received ' + words.length + '.',
    );
  }

  const slice = words.slice(0, needed);
  const buffer = wordsToBuffer(slice, spec.byteOrder ?? 'big', spec.wordOrder ?? 'big');
  const scale = spec.scale ?? 1;
  const offset = spec.offset ?? 0;

  let raw: number;
  switch (datatype) {
    case 'INT16':
      raw = buffer.readInt16BE(0);
      break;
    case 'UINT16':
      raw = buffer.readUInt16BE(0);
      break;
    case 'INT32':
      raw = buffer.readInt32BE(0);
      break;
    case 'UINT32':
      raw = buffer.readUInt32BE(0);
      break;
    case 'FLOAT32':
      raw = buffer.readFloatBE(0);
      break;
    case 'FLOAT64':
      raw = buffer.readDoubleBE(0);
      break;
    case 'INT64':
      // Energy counters can exceed 2^53, but a kWh register that large is not
      // physically meaningful; Number keeps the rest of the pipeline simple.
      raw = Number(buffer.readBigInt64BE(0));
      break;
    case 'UINT64':
      raw = Number(buffer.readBigUInt64BE(0));
      break;
    case 'BOOL': {
      const word = buffer.readUInt16BE(0);
      const bit = spec.bitOffset ?? 0;
      raw = (word >> bit) & 1;
      break;
    }
    case 'BITFIELD': {
      const word = buffer.readUInt16BE(0);
      const mask = spec.bitMask ?? 0xffff;
      const shift = spec.bitOffset ?? 0;
      raw = (word & mask) >> shift;
      break;
    }
    case 'STRING':
      throw new DecodeError('STRING registers are not numeric telemetry; map them as device metadata instead.');
  }

  if (!Number.isFinite(raw)) {
    throw new DecodeError('Decoded a non-finite value from ' + datatype + '.');
  }
  return { value: raw * scale + offset, raw };
}

/**
 * Normalise however a payload expressed register data into a word array.
 * Accepts `[1234, 5678]`, `"0x04D21A2E"` or `"04D2 1A2E"`.
 *
 * `encoding` is declared by the payload profile rather than sniffed: a numeric
 * array whose entries all happen to be below 256 is genuinely ambiguous, and
 * guessing wrong would corrupt every reading silently.
 */
export function coerceToWords(input: unknown, encoding: 'words' | 'bytes' = 'words'): number[] | null {
  if (typeof input === 'string') {
    try {
      return hexToWords(input);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(input)) return null;

  const numbers = input.map((entry) => (typeof entry === 'number' ? entry : Number(entry)));
  if (numbers.some((value) => !Number.isFinite(value))) return null;

  if (encoding === 'bytes') {
    if (numbers.length % 2 !== 0) return null;
    const words: number[] = [];
    for (let index = 0; index < numbers.length; index += 2) {
      words.push((((numbers[index] ?? 0) & 0xff) << 8) | ((numbers[index + 1] ?? 0) & 0xff));
    }
    return words;
  }
  return numbers.map((value) => value & 0xffff);
}
