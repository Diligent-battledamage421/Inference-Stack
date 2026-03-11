import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { lastValueFrom, toArray } from 'rxjs';
import { Router } from '../worker-orchestrator/router';
import { CreateVideoDto } from './dto/create-video.dto';

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);

  constructor(private readonly router: Router) {}

  async generate(dto: CreateVideoDto): Promise<Buffer> {
    const { worker } = await this.router.route(dto.model);

    const responses = await lastValueFrom(
      worker
        .infer({
          request_id: `vid-${Date.now()}`,
          model_id: dto.model,
          prompt: dto.prompt,
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
      throw new NotFoundException('No video generated');
    }

    return Buffer.concat(
      mediaResponses.map((r) => Buffer.from(r.media.data)),
    );
  }
}
