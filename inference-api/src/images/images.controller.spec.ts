import { Test, TestingModule } from '@nestjs/testing';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';

describe('ImagesController', () => {
  let controller: ImagesController;
  let service: ImagesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ImagesController],
      providers: [
        {
          provide: ImagesService,
          useValue: {
            generate: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ImagesController>(ImagesController);
    service = module.get<ImagesService>(ImagesService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should call service.generate and return result', async () => {
    const mockResult = {
      created: 1234567890,
      data: [{ b64_json: 'iVBOR...' }],
    };
    (service.generate as jest.Mock).mockResolvedValue(mockResult);

    const result = await controller.generate({
      model: 'stabilityai/sd-turbo',
      prompt: 'A cat in space',
    });

    expect(service.generate).toHaveBeenCalledWith({
      model: 'stabilityai/sd-turbo',
      prompt: 'A cat in space',
    });
    expect(result).toEqual(mockResult);
  });
});
