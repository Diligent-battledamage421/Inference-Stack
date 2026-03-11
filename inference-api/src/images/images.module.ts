import { Module } from '@nestjs/common';
import { ImagesController } from './images.controller';
import { ImagesService } from './images.service';
import { WorkerOrchestratorModule } from '../worker-orchestrator/worker-orchestrator.module';

@Module({
  imports: [WorkerOrchestratorModule],
  controllers: [ImagesController],
  providers: [ImagesService],
})
export class ImagesModule {}
