/**
 * OpenAI-compatible completion request DTO.
 * POST /v1/completions
 */
export class CreateCompletionDto {
  /** Model ID to use for completion */
  model: string;

  /** The prompt to complete */
  prompt: string;

  /** Maximum tokens to generate */
  max_tokens?: number;

  /** Sampling temperature (0-2) */
  temperature?: number;

  /** Nucleus sampling parameter */
  top_p?: number;

  /** Whether to stream the response via SSE */
  stream?: boolean;

  /** Stop sequences */
  stop?: string[];

  /** User identifier for per-user fairness in scheduling */
  user?: string;

  /** Priority tier for scheduling */
  priority?: 'high' | 'normal' | 'low';

  /** Base64-encoded images for vision models */
  images?: string[];
}
