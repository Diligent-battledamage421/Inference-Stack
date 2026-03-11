import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { lastValueFrom, toArray } from 'rxjs';
import { Router } from '../worker-orchestrator/router';
import { CreateImageDto } from './dto/create-image.dto';

@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(private readonly router: Router) {}

  async generate(dto: CreateImageDto): Promise<any> {
    const { worker } = await this.router.route(dto.model);

    const responses = await lastValueFrom(
      worker
        .infer({
          request_id: `img-${Date.now()}`,
          model_id: dto.model,
          prompt: dto.prompt,
          params: { max_tokens: 1 },
        })
        .pipe(toArray()),
    );

    // Collect media output
    const mediaResponses = responses.filter((r) => r.media);
    const complete = responses.find((r) => r.complete);
    const error = responses.find((r) => r.error);

    if (error) {
      throw new NotFoundException(error.error.message);
    }

    if (mediaResponses.length === 0) {
      throw new NotFoundException('No image generated');
    }

    // Combine media data (in case of chunks)
    const allData = Buffer.concat(
      mediaResponses.map((r) => Buffer.from(r.media.data)),
    );

    return {
      created: Math.floor(Date.now() / 1000),
      data: [
        {
          b64_json: allData.toString('base64'),
        },
      ],
    };
  }
}
