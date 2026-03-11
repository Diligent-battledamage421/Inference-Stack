import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { ImagesService } from './images.service';
import { CreateImageDto } from './dto/create-image.dto';

@Controller('v1/images')
export class ImagesController {
  constructor(private readonly imagesService: ImagesService) {}

  @Post('generations')
  @HttpCode(200)
  async generate(@Body() dto: CreateImageDto) {
    return this.imagesService.generate(dto);
  }
}
