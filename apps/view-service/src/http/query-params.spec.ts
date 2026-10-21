import { BadRequestException } from '@nestjs/common';
import { optionalList, optionalNumber, optionalUuid } from './query-params.js';

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse();
  }
  throw new Error('expected a BadRequestException');
}

describe('optionalNumber', () => {
  it('parses numbers and treats missing or empty as not set', () => {
    expect(optionalNumber('n', '12.5')).toBe(12.5);
    expect(optionalNumber('n', undefined)).toBeUndefined();
    expect(optionalNumber('n', '')).toBeUndefined();
  });

  it('rejects text, infinity and repeated values', () => {
    expect(errorOf(() => optionalNumber('minPrice', 'cheap'))).toEqual({
      code: 'INVALID_PARAM',
      message: 'minPrice must be a number',
    });
    errorOf(() => optionalNumber('n', 'Infinity'));
    errorOf(() => optionalNumber('n', ['1', '2']));
  });
});

describe('optionalUuid', () => {
  const id = '6F9619FF-8B86-D011-B42D-00C04FC964FF';

  it('accepts a uuid in lower case and treats missing as not set', () => {
    expect(optionalUuid('id', id)).toBe(id.toLowerCase());
    expect(optionalUuid('id', undefined)).toBeUndefined();
  });

  it('rejects anything else', () => {
    expect(errorOf(() => optionalUuid('customerId', 'abc'))).toEqual({
      code: 'INVALID_PARAM',
      message: 'customerId must be a uuid',
    });
  });
});

describe('optionalList', () => {
  it('turns one or repeated values into a list', () => {
    expect(optionalList('type', 'book')).toEqual(['book']);
    expect(optionalList('type', ['book', 'food'])).toEqual(['book', 'food']);
    expect(optionalList('type', undefined)).toBeUndefined();
  });

  it('rejects empty values and lists over 200', () => {
    errorOf(() => optionalList('type', ['book', '']));
    errorOf(() =>
      optionalList(
        'type',
        Array.from({ length: 201 }, () => 'a'),
      ),
    );
  });
});
