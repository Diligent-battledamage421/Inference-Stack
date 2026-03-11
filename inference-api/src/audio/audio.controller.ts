import { Controller, Post, Body, HttpCode, Res } from '@nestjs/common';
import { Response } from 'express';
import { AudioService } from './audio.service';
import { CreateSpeechDto } from './dto/create-speech.dto';

@Controller('v1/audio')
export class AudioController {
  constructor(private readonly audioService: AudioService) {}

  @Post('speech')
  @HttpCode(200)
  async speech(@Body() dto: CreateSpeechDto, @Res() res: Response) {
    const wavBuffer = await this.audioService.speech(dto);
    res.set('Content-Type', 'audio/wav');
    res.set('Content-Length', String(wavBuffer.length));
    res.send(wavBuffer);
  }
}
