import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DecodeError,
  coerceToWords,
  decodeRegisters,
  defaultRegisterLength,
  hexToWords,
  wordsToBuffer,
} from '../src/iot/modbus/decoder.js';

/**
 * Byte and word order is the single most common cause of a meter integration
 * producing confident nonsense, so every combination is pinned here.
 *
 * 0x12345678 as a FLOAT32 is 5.690456e-28; as a UINT32 it is 305419896.
 */
const VALUE_WORDS = {
  ABCD: [0x1234, 0x5678], // big byte, big word   - Modbus default
  CDAB: [0x5678, 0x1234], // big byte, little word - "word swapped"
  BADC: [0x3412, 0x7856], // little byte, big word - "byte swapped"
  DCBA: [0x7856, 0x3412], // little byte, little word
};

test('all four byte/word orders decode to the same UINT32', () => {
  const expected = 0x12345678;
  const cases: Array<[number[], 'big' | 'little', 'big' | 'little']> = [
    [VALUE_WORDS.ABCD, 'big', 'big'],
    [VALUE_WORDS.CDAB, 'big', 'little'],
    [VALUE_WORDS.BADC, 'little', 'big'],
    [VALUE_WORDS.DCBA, 'little', 'little'],
  ];

  for (const [words, byteOrder, wordOrder] of cases) {
    const result = decodeRegisters(words, { datatype: 'UINT32', byteOrder, wordOrder });
    assert.equal(result.raw, expected, byteOrder + '/' + wordOrder + ' should decode to ' + expected);
  }
});

test('FLOAT32 decodes a real voltage in the common word-swapped layout', () => {
  // 231.6 as an IEEE-754 single is 0x4367999A.
  const abcd = decodeRegisters([0x4367, 0x999a], { datatype: 'FLOAT32', byteOrder: 'big', wordOrder: 'big' });
  assert.ok(Math.abs(abcd.value - 231.6) < 0.001, 'ABCD decoded ' + abcd.value);

  // The same value as a word-swapped meter would send it.
  const cdab = decodeRegisters([0x999a, 0x4367], { datatype: 'FLOAT32', byteOrder: 'big', wordOrder: 'little' });
  assert.ok(Math.abs(cdab.value - 231.6) < 0.001, 'CDAB decoded ' + cdab.value);
});

test('signed 16-bit values stay signed', () => {
  const result = decodeRegisters([0xfffe], { datatype: 'INT16' });
  assert.equal(result.raw, -2);
  assert.equal(decodeRegisters([0xfffe], { datatype: 'UINT16' }).raw, 65534);
});

test('scale and offset produce engineering units', () => {
  // A meter reporting deci-volts: 2316 raw, scale 0.1, gives 231.6 V.
  const result = decodeRegisters([2316], { datatype: 'UINT16', scale: 0.1 });
  assert.equal(result.raw, 2316);
  assert.ok(Math.abs(result.value - 231.6) < 1e-9);

  const withOffset = decodeRegisters([100], { datatype: 'UINT16', scale: 2, offset: -50 });
  assert.equal(withOffset.value, 150);
});

test('a 64-bit energy counter decodes', () => {
  const words = [0x0000, 0x0000, 0x0001, 0x0000]; // 65536
  assert.equal(decodeRegisters(words, { datatype: 'UINT64' }).raw, 65536);
});

test('bitfields mask and shift', () => {
  const result = decodeRegisters([0b0000_0000_1111_0000], {
    datatype: 'BITFIELD',
    bitMask: 0b0000_0000_1111_0000,
    bitOffset: 4,
  });
  assert.equal(result.raw, 0b1111);
});

test('too few registers is an error, not a silent zero', () => {
  assert.throws(() => decodeRegisters([0x1234], { datatype: 'FLOAT32' }), DecodeError);
});

test('hex register payloads convert to words', () => {
  assert.deepEqual(hexToWords('0x12345678'), [0x1234, 0x5678]);
  assert.deepEqual(hexToWords('1234 5678'), [0x1234, 0x5678]);
  assert.throws(() => hexToWords('12345'), DecodeError);
});

test('register arrays are read as words unless bytes are declared', () => {
  // The ambiguous case: every entry fits in a byte. Guessing here would
  // corrupt every reading, so the encoding is declared, never sniffed.
  assert.deepEqual(coerceToWords([1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(coerceToWords([1, 2, 3, 4], 'bytes'), [0x0102, 0x0304]);
});

test('default register lengths match datatype widths', () => {
  assert.equal(defaultRegisterLength('UINT16'), 1);
  assert.equal(defaultRegisterLength('FLOAT32'), 2);
  assert.equal(defaultRegisterLength('FLOAT64'), 4);
});

test('wordsToBuffer lays bytes out big-endian after the swaps', () => {
  assert.equal(wordsToBuffer([0x1234], 'big', 'big').toString('hex'), '1234');
  assert.equal(wordsToBuffer([0x1234], 'little', 'big').toString('hex'), '3412');
  assert.equal(wordsToBuffer([0x1234, 0x5678], 'big', 'little').toString('hex'), '56781234');
});
