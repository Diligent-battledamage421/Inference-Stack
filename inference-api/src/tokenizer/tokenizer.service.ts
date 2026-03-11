import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

@Injectable()
export class TokenizerService {
  /**
   * Approximate token count using chars/4 heuristic.
   * Sufficient for scheduler token budgets and context window pre-checks.
   * Replace with exact HuggingFace tokenizer in a future phase.
   */
  estimateTokenCount(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Throws 400 if promptTokens + maxTokens exceeds the model's context window.
   */
  validateContextWindow(
    promptTokens: number,
    maxTokens: number,
    maxContextLength: number,
  ): void {
    const total = promptTokens + maxTokens;
    if (total > maxContextLength) {
      throw new HttpException(
        {
          error: {
            message: `Request requires ${total} tokens (${promptTokens} prompt + ${maxTokens} completion) but model context window is ${maxContextLength}`,
            type: 'invalid_request_error',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
