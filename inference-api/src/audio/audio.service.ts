import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { lastValueFrom, toArray } from 'rxjs';
import { Router } from '../worker-orchestrator/router';
import { CreateSpeechDto } from './dto/create-speech.dto';

@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);

  constructor(private readonly router: Router) {}

  async speech(dto: CreateSpeechDto): Promise<Buffer> {
    const { worker } = await this.router.route(dto.model);

    const responses = await lastValueFrom(
      worker
        .infer({
          request_id: `tts-${Date.now()}`,
          model_id: dto.model,
          prompt: dto.input,
          params: { max_tokens: 1 },
        })
        .pipe(toArray()),
    );

    const mediaResponses = responses.filter((r) => r.media);
    const error = responses.find((r) => r.error);

    if (error) {
      throw new NotFoundException(error.error.message);
    }

    if (mediaResponses.length === 0) {
      throw new NotFoundException('No audio generated');
    }

    return Buffer.concat(
      mediaResponses.map((r) => Buffer.from(r.media.data)),
    );
  }
}
