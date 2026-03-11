import { Controller, Post, Body, HttpCode, Res } from '@nestjs/common';
import { Response } from 'express';
import { VideoService } from './video.service';
import { CreateVideoDto } from './dto/create-video.dto';

@Controller('v1/video')
export class VideoController {
  constructor(private readonly videoService: VideoService) {}

  @Post('generations')
  @HttpCode(200)
  async generate(@Body() dto: CreateVideoDto, @Res() res: Response) {
    const mp4Buffer = await this.videoService.generate(dto);
    res.set('Content-Type', 'video/mp4');
    res.set('Content-Length', String(mp4Buffer.length));
    res.send(mp4Buffer);
  }
}
