import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { TokenizerService } from './tokenizer.service';

describe('TokenizerService', () => {
  let service: TokenizerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TokenizerService],
    }).compile();

    service = module.get<TokenizerService>(TokenizerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('estimateTokenCount', () => {
    it('should approximate tokens as ceil(chars / 4)', () => {
      expect(service.estimateTokenCount('Hello world')).toBe(3); // 11 chars
      expect(service.estimateTokenCount('a')).toBe(1);
      expect(service.estimateTokenCount('abcd')).toBe(1); // exactly 4
      expect(service.estimateTokenCount('abcde')).toBe(2); // 5 chars
    });

    it('should return 0 for empty string', () => {
      expect(service.estimateTokenCount('')).toBe(0);
    });
  });

  describe('validateContextWindow', () => {
    it('should pass when prompt + max_tokens fits within context window', () => {
      expect(() =>
        service.validateContextWindow(100, 50, 2048),
      ).not.toThrow();
    });

    it('should pass when exactly at context window limit', () => {
      expect(() =>
        service.validateContextWindow(1000, 1048, 2048),
      ).not.toThrow();
    });

    it('should throw 400 when prompt + max_tokens exceeds context window', () => {
      try {
        service.validateContextWindow(2000, 100, 2048);
        fail('Expected HttpException');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        const body = err.getResponse();
        expect(body.error.type).toBe('invalid_request_error');
        expect(body.error.message).toContain('2100');
        expect(body.error.message).toContain('2048');
      }
    });
  });
});
