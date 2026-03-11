import { Test, TestingModule } from '@nestjs/testing';
import { VideoController } from './video.controller';
import { VideoService } from './video.service';

describe('VideoController', () => {
  let controller: VideoController;
  let service: VideoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VideoController],
      providers: [
        {
          provide: VideoService,
          useValue: {
            generate: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<VideoController>(VideoController);
    service = module.get<VideoService>(VideoService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return MP4 bytes with correct headers', async () => {
    const mp4Buffer = Buffer.from('fake-mp4-data');
    (service.generate as jest.Mock).mockResolvedValue(mp4Buffer);

    const mockRes = {
      set: jest.fn(),
      send: jest.fn(),
    };

    await controller.generate(
      { model: 'THUDM/CogVideoX-2b', prompt: 'A sunset over ocean' },
      mockRes as any,
    );

    expect(service.generate).toHaveBeenCalledWith({
      model: 'THUDM/CogVideoX-2b',
      prompt: 'A sunset over ocean',
    });
    expect(mockRes.set).toHaveBeenCalledWith('Content-Type', 'video/mp4');
    expect(mockRes.set).toHaveBeenCalledWith(
      'Content-Length',
      String(mp4Buffer.length),
    );
    expect(mockRes.send).toHaveBeenCalledWith(mp4Buffer);
  });
});
