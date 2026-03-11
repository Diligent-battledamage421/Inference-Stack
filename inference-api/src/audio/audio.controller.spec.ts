import { Test, TestingModule } from '@nestjs/testing';
import { AudioController } from './audio.controller';
import { AudioService } from './audio.service';

describe('AudioController', () => {
  let controller: AudioController;
  let service: AudioService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AudioController],
      providers: [
        {
          provide: AudioService,
          useValue: {
            speech: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<AudioController>(AudioController);
    service = module.get<AudioService>(AudioService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return WAV bytes with correct headers', async () => {
    const wavBuffer = Buffer.from('RIFF-fake-wav-data');
    (service.speech as jest.Mock).mockResolvedValue(wavBuffer);

    const mockRes = {
      set: jest.fn(),
      send: jest.fn(),
    };

    await controller.speech(
      { model: 'hexgrad/Kokoro-82M', input: 'Hello world' },
      mockRes as any,
    );

    expect(service.speech).toHaveBeenCalledWith({
      model: 'hexgrad/Kokoro-82M',
      input: 'Hello world',
    });
    expect(mockRes.set).toHaveBeenCalledWith('Content-Type', 'audio/wav');
    expect(mockRes.set).toHaveBeenCalledWith(
      'Content-Length',
      String(wavBuffer.length),
    );
    expect(mockRes.send).toHaveBeenCalledWith(wavBuffer);
  });
});
